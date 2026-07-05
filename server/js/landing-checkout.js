(() => {
  const CHECKOUT_COMPLETED_EVENT = "translay:checkout-completed";
  const CHECKOUT_ERROR_EVENT = "translay:checkout-error";
  const CHECKOUT_SUCCESS_PLAN_KEY = "translay.checkout.success.plan";
  const CHECKOUT_SUCCESS_DIALOG_PLAN_KEY = "translay.checkout.success.dialog.plan";

  function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function createCheckoutDisabledError() {
    const error = new Error(
      "Checkout is disabled in the open-source landing page. Configure your own billing provider before enabling payments."
    );
    error.code = "checkout_disabled";
    return error;
  }

  async function openSubscriptionCheckout() {
    throw createCheckoutDisabledError();
  }

  async function openCreditsCheckout() {
    throw createCheckoutDisabledError();
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
