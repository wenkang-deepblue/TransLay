(() => {
  const AUTH_HINT_KEY = "translay.portal-auth.hint.v2";
  const LEGACY_AUTH_SNAPSHOT_KEY = "translay.portal-auth.snapshot.v1";
  const AUTH_HINT_TTL_MS = 30 * 60 * 1000;

  function getApiBaseUrl() {
    const apiBaseUrl = window.TransLayLandingConfig?.apiBaseUrl;
    return typeof apiBaseUrl === "string" && apiBaseUrl.trim() ? apiBaseUrl.trim() : "/api";
  }

  function buildApiUrl(path) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${getApiBaseUrl()}${normalizedPath}`;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return {};
    }
  }

  async function request(path, { method = "GET", headers = {}, body } = {}) {
    const response = await fetch(buildApiUrl(path), {
      method,
      cache: "no-store",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await readJson(response);
    if (!response.ok) {
      const message = typeof payload?.message === "string" ? payload.message : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function buildSignedOutState(errorMessage = "") {
    return {
      status: "signed_out",
      user: null,
      planType: "free",
      subscriptionStatus: "active",
      subscription: null,
      creditBalance: null,
      errorMessage,
    };
  }

  function getHintStorage() {
    try {
      return window.sessionStorage;
    } catch (_) {
      return null;
    }
  }

  function normalizeSignedInState(payload) {
    return {
      status: "signed_in",
      user: {
        googleSubjectId: payload.user.google_subject_id,
        email: payload.user.email ?? null,
        displayName: payload.user.display_name ?? null,
        avatarUrl: payload.user.avatar_url ?? null,
      },
      planType: payload.plan_type ?? "free",
      subscriptionStatus: payload.subscription_status ?? "active",
      subscription: payload?.subscription
        ? {
            providerName: payload.subscription.provider_name ?? "",
            currentPeriodStart: payload.subscription.current_period_start ?? "",
            currentPeriodEnd: payload.subscription.current_period_end ?? "",
            cancelAtPeriodEnd: Boolean(payload.subscription.cancel_at_period_end),
        }
        : null,
      creditBalance: payload?.credit_balance ?? null,
      errorMessage: "",
    };
  }

  function normalizeSessionState(payload) {
    if (payload?.signed_in === false) {
      return buildSignedOutState("");
    }

    if (payload?.signed_in === true || payload?.ok === true) {
      return normalizeSignedInState(payload);
    }

    return buildSignedOutState("Unable to determine sign-in state.");
  }

  function clearLegacyAuthSnapshot() {
    try {
      window.localStorage?.removeItem(LEGACY_AUTH_SNAPSHOT_KEY);
    } catch (_) {
      // Best-effort cleanup for the retired PII-bearing snapshot.
    }
  }

  function buildStoredHint(state) {
    if (state?.status !== "signed_in") {
      return null;
    }

    return {
      version: 2,
      expiresAtMs: Date.now() + AUTH_HINT_TTL_MS,
      hadSignedInSession: true,
      planType: state.planType ?? "free",
      subscriptionStatus: state.subscriptionStatus ?? "active",
    };
  }

  function readAuthSnapshot() {
    clearLegacyAuthSnapshot();
    const storage = getHintStorage();
    if (!storage) {
      return null;
    }

    try {
      const raw = storage.getItem(AUTH_HINT_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (parsed?.version !== 2 || parsed?.hadSignedInSession !== true) {
        storage.removeItem(AUTH_HINT_KEY);
        return null;
      }

      const expiresAtMs = Number(parsed?.expiresAtMs ?? 0);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        storage.removeItem(AUTH_HINT_KEY);
        return null;
      }

      return {
        status: "loading",
        user: null,
        planType: typeof parsed?.planType === "string" ? parsed.planType : "free",
        subscriptionStatus:
          typeof parsed?.subscriptionStatus === "string"
            ? parsed.subscriptionStatus
            : "active",
        subscription: null,
        creditBalance: null,
        errorMessage: "",
      };
    } catch (_) {
      try {
        storage.removeItem(AUTH_HINT_KEY);
      } catch (_) {}
      return null;
    }
  }

  function writeAuthSnapshot(state) {
    clearLegacyAuthSnapshot();
    const storage = getHintStorage();
    const hint = buildStoredHint(state);
    if (!storage || !hint) {
      return;
    }

    try {
      storage.setItem(AUTH_HINT_KEY, JSON.stringify(hint));
    } catch (_) {
      // Best-effort UI hydration only.
    }
  }

  function clearAuthSnapshot() {
    clearLegacyAuthSnapshot();
    const storage = getHintStorage();
    if (!storage) {
      return;
    }

    try {
      storage.removeItem(AUTH_HINT_KEY);
    } catch (_) {
      // Best-effort UI hydration only.
    }
  }

  function rememberSessionState(payload) {
    const state = normalizeSessionState(payload);
    if (state.status === "signed_in") {
      writeAuthSnapshot(state);
    } else {
      clearAuthSnapshot();
    }
    return state;
  }

  function getTicketFromLocation(locationLike = window.location) {
    const preloadedTicket =
      typeof window.__TRANSLAY_PORTAL_TICKET__ === "string"
        ? window.__TRANSLAY_PORTAL_TICKET__.trim()
        : "";
    if (preloadedTicket) {
      return preloadedTicket;
    }

    const href = typeof locationLike?.href === "string" ? locationLike.href : window.location.href;
    const url = new URL(href, window.location.origin);
    const ticket = url.searchParams.get("ticket");
    return typeof ticket === "string" && ticket.trim() ? ticket.trim() : "";
  }

  function stripTicketFromUrl() {
    window.__TRANSLAY_PORTAL_TICKET__ = "";
    const url = new URL(window.location.href);
    if (!url.searchParams.has("ticket")) {
      return;
    }

    url.searchParams.delete("ticket");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
  }

  async function fetchSessionMe() {
    return request("/session/me");
  }

  async function fetchCreditBalance() {
    return request("/credits/balance");
  }

  async function requestCreditRefund(quantity, reason = "") {
    return request("/refunds/request", {
      method: "POST",
      body: {
        unit: "slides_pages",
        quantity,
        ...(reason ? { reason } : {}),
      },
    });
  }

  async function consumeTicket(ticket) {
    return request("/session/consume", {
      method: "POST",
      body: { ticket },
    });
  }

  async function loginWithGoogleCredential(credential) {
    return request("/session/login", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
      },
    });
  }

  async function logout() {
    return request("/session/logout", {
      method: "POST",
    });
  }

  async function changeSubscriptionPlan(planType, options = {}) {
    return request("/subscription/change-plan", {
      method: "POST",
      body: {
        plan_type: planType,
        ...(options.confirmUpgradeCharge ? { confirm_upgrade_charge: true } : {}),
      },
    });
  }

  async function cancelSubscription() {
    return request("/subscription/cancel", {
      method: "POST",
    });
  }

  window.TransLayLandingSession = {
    buildSignedOutState,
    normalizeSessionState,
    rememberSessionState,
    readAuthSnapshot,
    writeAuthSnapshot,
    clearAuthSnapshot,
    getTicketFromLocation,
    stripTicketFromUrl,
    fetchSessionMe,
    fetchCreditBalance,
    requestCreditRefund,
    consumeTicket,
    loginWithGoogleCredential,
    changeSubscriptionPlan,
    cancelSubscription,
    logout,
  };
})();
