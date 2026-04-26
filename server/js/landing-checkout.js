(() => {
  const CHECKOUT_COMPLETED_EVENT = "translay:paddle-checkout-completed";
  const CHECKOUT_ERROR_EVENT = "translay:paddle-checkout-error";
  const CHECKOUT_SUCCESS_PLAN_KEY = "translay.checkout.success.plan";
  const CHECKOUT_SUCCESS_DIALOG_PLAN_KEY = "translay.checkout.success.dialog.plan";
  let paddleInitialized = false;

  function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function createError(code, fallbackMessage) {
    const error = new Error(fallbackMessage || code);
    error.code = code;
    return error;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return {};
    }
  }

  async function ensurePublicConfig() {
    if (typeof window.TransLayLandingConfig?.load === "function") {
      await window.TransLayLandingConfig.load();
    }
  }

  function ensurePaddleInitialized() {
    const billingProvider = window.TransLayLandingConfig?.getBillingProvider?.() || "";
    const clientToken = window.TransLayLandingConfig?.getPaddleClientToken?.() || "";
    const environment = window.TransLayLandingConfig?.getPaddleEnvironment?.() || "sandbox";
    if (billingProvider !== "paddle" || !clientToken) {
      throw createError("paddle_not_configured", "Secure checkout is not configured yet.");
    }
    if (!window.Paddle?.Initialize || !window.Paddle?.Checkout?.open) {
      throw createError("paddle_sdk_unavailable", "Secure checkout is temporarily unavailable.");
    }

    if (paddleInitialized) {
      return;
    }

    if (environment === "sandbox") {
      window.Paddle.Environment?.set?.("sandbox");
    }

    window.Paddle.Initialize({
      token: clientToken,
      eventCallback(event) {
        const eventName = normalizeString(event?.name);
        if (eventName === "checkout.completed") {
          window.dispatchEvent(new CustomEvent(CHECKOUT_COMPLETED_EVENT, { detail: event }));
        }
        if (eventName === "checkout.payment.failed" || eventName === "checkout.payment.error") {
          window.dispatchEvent(new CustomEvent(CHECKOUT_ERROR_EVENT, { detail: event }));
        }
      },
    });
    paddleInitialized = true;
  }

  async function createSubscriptionCheckout(planType) {
    const response = await fetch("/api/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_type: "subscription",
        plan_type: planType,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw createError(
        payload?.error || "checkout_failed",
        payload?.message || "Unable to start checkout right now."
      );
    }
    return payload;
  }

  async function createCreditsCheckout(sku, quantity) {
    const response = await fetch("/api/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_type: "credits",
        sku,
        quantity,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw createError(
        payload?.error || "checkout_failed",
        payload?.message || "Unable to start checkout right now."
      );
    }
    return payload;
  }

  async function openSubscriptionCheckout({ planType, email, locale }) {
    await ensurePublicConfig();
    ensurePaddleInitialized();

    const payload = await createSubscriptionCheckout(planType);
    openPaddleOverlay(payload, email, locale);
  }

  async function openCreditsCheckout({ sku = "slides", quantity = 1, email, locale }) {
    await ensurePublicConfig();
    ensurePaddleInitialized();

    const payload = await createCreditsCheckout(sku, quantity);
    openPaddleOverlay(payload, email, locale);
  }

	  function openPaddleOverlay(payload, email, locale) {
	    const checkout = {
	      customer: email
	        ? {
	            email,
	          }
	        : undefined,
	      settings: {
	        displayMode: "overlay",
	        variant: "one-page",
	        allowLogout: false,
	        locale: normalizeString(locale) || "en",
	        theme: "light",
	      },
	    };
	    if (payload.transaction_id) {
	      checkout.transactionId = payload.transaction_id;
	    } else {
	      checkout.items = [
	        {
	          priceId: payload.price_id,
	          quantity: payload.custom_data?.quantity || 1,
	        },
	      ];
	      checkout.customData = payload.custom_data;
	    }
	    window.Paddle.Checkout.open(checkout);
	  }

  function rememberSuccessfulPlan(planType) {
    try {
      window.sessionStorage.setItem(CHECKOUT_SUCCESS_PLAN_KEY, normalizeString(planType));
    } catch (_) {}
  }

  function readSuccessfulPlan() {
    try {
      return normalizeString(window.sessionStorage.getItem(CHECKOUT_SUCCESS_PLAN_KEY));
    } catch (_) {
      return "";
    }
  }

  function clearSuccessfulPlan() {
    try {
      window.sessionStorage.removeItem(CHECKOUT_SUCCESS_PLAN_KEY);
    } catch (_) {}
  }

  function rememberPendingSuccessDialog(planType) {
    try {
      window.sessionStorage.setItem(
        CHECKOUT_SUCCESS_DIALOG_PLAN_KEY,
        normalizeString(planType)
      );
    } catch (_) {}
  }

  function readPendingSuccessDialogPlan() {
    try {
      return normalizeString(
        window.sessionStorage.getItem(CHECKOUT_SUCCESS_DIALOG_PLAN_KEY)
      );
    } catch (_) {
      return "";
    }
  }

  function clearPendingSuccessDialog() {
    try {
      window.sessionStorage.removeItem(CHECKOUT_SUCCESS_DIALOG_PLAN_KEY);
    } catch (_) {}
  }

  window.TransLayLandingCheckoutEvents = {
    completed: CHECKOUT_COMPLETED_EVENT,
    error: CHECKOUT_ERROR_EVENT,
  };
  window.TransLayLandingCheckout = {
    openSubscriptionCheckout,
    openCreditsCheckout,
    rememberSuccessfulPlan,
    readSuccessfulPlan,
    clearSuccessfulPlan,
    rememberPendingSuccessDialog,
    readPendingSuccessDialogPlan,
    clearPendingSuccessDialog,
  };
})();
