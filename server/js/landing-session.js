(() => {
  const AUTH_SNAPSHOT_KEY = "translay.portal-auth.snapshot.v1";
  const AUTH_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const SNAPSHOT_TEXT_MAX_LENGTH = 256;

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

  function getSnapshotStorage() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function sanitizeSnapshotText(value) {
    if (typeof value !== "string") {
      return null;
    }

    return value.slice(0, SNAPSHOT_TEXT_MAX_LENGTH);
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

  function buildStoredSnapshot(state) {
    if (state?.status !== "signed_in" || !state.user?.googleSubjectId) {
      return null;
    }

    return {
      version: 1,
      expiresAtMs: Date.now() + AUTH_SNAPSHOT_TTL_MS,
      user: {
        googleSubjectId: state.user.googleSubjectId,
        email: state.user.email ?? null,
        displayName: state.user.displayName ?? null,
        avatarUrl: state.user.avatarUrl ?? null,
      },
      planType: state.planType ?? "free",
      subscriptionStatus: state.subscriptionStatus ?? "active",
      subscription: state.subscription
        ? {
            providerName: state.subscription.providerName ?? "",
            currentPeriodStart: state.subscription.currentPeriodStart ?? "",
            currentPeriodEnd: state.subscription.currentPeriodEnd ?? "",
            cancelAtPeriodEnd: Boolean(state.subscription.cancelAtPeriodEnd),
          }
        : null,
      creditBalance: state.creditBalance ?? null,
    };
  }

  function readAuthSnapshot() {
    const storage = getSnapshotStorage();
    if (!storage) {
      return null;
    }

    try {
      const raw = storage.getItem(AUTH_SNAPSHOT_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1) {
        storage.removeItem(AUTH_SNAPSHOT_KEY);
        return null;
      }

      const expiresAtMs = Number(parsed?.expiresAtMs ?? 0);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        storage.removeItem(AUTH_SNAPSHOT_KEY);
        return null;
      }

      const googleSubjectId =
        typeof parsed?.user?.googleSubjectId === "string"
          ? parsed.user.googleSubjectId.trim()
          : "";
      if (!googleSubjectId) {
        storage.removeItem(AUTH_SNAPSHOT_KEY);
        return null;
      }

      return {
        status: "signed_in",
        user: {
          googleSubjectId,
          email: sanitizeSnapshotText(parsed?.user?.email),
          displayName: sanitizeSnapshotText(parsed?.user?.displayName),
          avatarUrl: sanitizeSnapshotText(parsed?.user?.avatarUrl),
        },
        planType: typeof parsed?.planType === "string" ? parsed.planType : "free",
        subscriptionStatus:
          typeof parsed?.subscriptionStatus === "string"
            ? parsed.subscriptionStatus
            : "active",
        subscription:
          parsed?.subscription && typeof parsed.subscription === "object"
            ? {
                providerName:
                  typeof parsed.subscription.providerName === "string"
                    ? parsed.subscription.providerName
                    : "",
                currentPeriodStart:
                  typeof parsed.subscription.currentPeriodStart === "string"
                    ? parsed.subscription.currentPeriodStart
                    : "",
                currentPeriodEnd:
                  typeof parsed.subscription.currentPeriodEnd === "string"
                    ? parsed.subscription.currentPeriodEnd
                    : "",
                cancelAtPeriodEnd: Boolean(parsed.subscription.cancelAtPeriodEnd),
              }
            : null,
        creditBalance: parsed?.creditBalance ?? null,
        errorMessage: "",
      };
    } catch (_) {
      try {
        storage.removeItem(AUTH_SNAPSHOT_KEY);
      } catch (_) {}
      return null;
    }
  }

  function writeAuthSnapshot(state) {
    const storage = getSnapshotStorage();
    const snapshot = buildStoredSnapshot(state);
    if (!storage || !snapshot) {
      return;
    }

    try {
      storage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (_) {
      // Best-effort UI hydration only.
    }
  }

  function clearAuthSnapshot() {
    const storage = getSnapshotStorage();
    if (!storage) {
      return;
    }

    try {
      storage.removeItem(AUTH_SNAPSHOT_KEY);
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
