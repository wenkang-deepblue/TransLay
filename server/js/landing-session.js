(() => {
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
      errorMessage,
    };
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

  function getTicketFromLocation(locationLike = window.location) {
    const href = typeof locationLike?.href === "string" ? locationLike.href : window.location.href;
    const url = new URL(href, window.location.origin);
    const ticket = url.searchParams.get("ticket");
    return typeof ticket === "string" && ticket.trim() ? ticket.trim() : "";
  }

  function stripTicketFromUrl() {
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

  window.TransLayLandingSession = {
    buildSignedOutState,
    normalizeSessionState,
    getTicketFromLocation,
    stripTicketFromUrl,
    fetchSessionMe,
    consumeTicket,
    loginWithGoogleCredential,
    logout,
  };
})();
