(() => {
  let cleanupOutsideClick = null;

  function createEscapedText(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getBrowserLang() {
    const lang = String(navigator.language || "en").toLowerCase();
    if (lang.startsWith("zh")) return lang.includes("tw") || lang.includes("hk") ? "zh-TW" : "zh";
    const base = lang.split("-")[0];
    const supported = ["en", "fr", "de", "it", "es", "pt", "ru", "nl", "sv", "el", "ar", "he", "ja", "ko"];
    return supported.includes(base) ? base : "en";
  }

  function getTranslations() {
    const currentLang = document.documentElement.lang || getBrowserLang();
    return (
      window.TRANSLATIONS?.[currentLang] ||
      window.TRANSLATIONS?.[currentLang.split("-")[0]] ||
      window.TRANSLATIONS?.en ||
      { auth: {} }
    );
  }

  function getPlanLabel(translations, planType) {
    return planType === "free"
      ? translations?.auth?.plan_free || "Free"
      : translations?.auth?.plan_paid || "Pro";
  }

  function buildSignedInMarkup(state, translations) {
    const displayName = state.user?.displayName || state.user?.email || "Account";
    const planLabel = getPlanLabel(translations, state.planType);
    const email = state.user?.email || displayName;
    const avatarUrl = state.user?.avatarUrl || "";

    const avatarHtml = avatarUrl
      ? `<img class="account-avatar" src="${createEscapedText(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="account-avatar account-avatar-fallback">${createEscapedText(displayName.slice(0, 1).toUpperCase())}</span>`;

    return `
      <div class="account-shell">
        <button class="account-trigger" type="button" data-legal-account-trigger>
          ${avatarHtml}
          <span class="account-copy">
            <span class="account-name">${createEscapedText(displayName)}</span>
            <span class="account-plan">${createEscapedText(planLabel)}</span>
          </span>
        </button>
        <div class="account-menu" data-legal-account-menu hidden>
          <div class="account-menu-label">${createEscapedText(translations?.auth?.signed_in_as || "Signed in as")}</div>
          <div class="account-menu-email">${createEscapedText(email)}</div>
          <button class="account-menu-action" type="button" data-legal-logout>${createEscapedText(translations?.auth?.sign_out || "Sign out")}</button>
        </div>
      </div>
    `;
  }

  function buildLoadingMarkup(message) {
    return `<div class="auth-status-chip">${createEscapedText(message)}</div>`;
  }

  async function renderAuthSlot(slot, state) {
    if (!slot) return;
    const translations = getTranslations();

    cleanupOutsideClick?.();
    cleanupOutsideClick = null;

    if (state.status === "signed_in") {
      slot.innerHTML = buildSignedInMarkup(state, translations);
      const trigger = slot.querySelector("[data-legal-account-trigger]");
      const menu = slot.querySelector("[data-legal-account-menu]");
      const logoutButton = slot.querySelector("[data-legal-logout]");

      trigger?.addEventListener("click", () => {
        if (!menu) return;
        menu.hidden = !menu.hidden;
      });

      logoutButton?.addEventListener("click", async () => {
        try {
          await window.TransLayLandingSession.logout();
        } catch (error) {
          console.warn("Portal logout failed:", error?.message || error);
        }
        await bootstrapAuthSlot(slot);
      });

      const onDocumentClick = (event) => {
        if (!menu || !trigger) return;
        if (slot.contains(event.target)) return;
        menu.hidden = true;
      };
      document.addEventListener("click", onDocumentClick);
      cleanupOutsideClick = () => document.removeEventListener("click", onDocumentClick);
      return;
    }

    if (state.status === "signing_in") {
      slot.innerHTML = buildLoadingMarkup(
        translations?.auth?.signing_in || "Completing sign-in..."
      );
      return;
    }

    slot.innerHTML = "";
    try {
      await window.TransLayLandingAuth.mountGoogleButton({
        container: slot,
        locale: document.documentElement.lang || "en",
        onCredential: async (credential) => {
          slot.innerHTML = buildLoadingMarkup(
            translations?.auth?.signing_in || "Completing sign-in..."
          );
          try {
            const payload = await window.TransLayLandingSession.loginWithGoogleCredential(credential);
            await renderAuthSlot(slot, window.TransLayLandingSession.normalizeSessionState(payload));
          } catch (error) {
            console.warn("Legal page sign-in failed:", error?.message || error);
            await bootstrapAuthSlot(slot);
          }
        },
      });
    } catch (_) {
      slot.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" disabled>${createEscapedText(translations?.auth?.google_client_missing || "Google sign-in is not configured yet.")}</button>`;
    }
  }

  async function bootstrapAuthSlot(slot) {
    if (!slot) return;
    const translations = getTranslations();
    slot.innerHTML = buildLoadingMarkup(
      translations?.auth?.loading || "Checking session..."
    );

    try {
      const payload = await window.TransLayLandingSession.fetchSessionMe();
      const state = window.TransLayLandingSession.normalizeSessionState(payload);
      await renderAuthSlot(slot, state);
    } catch (_) {
      await renderAuthSlot(slot, window.TransLayLandingSession.buildSignedOutState(""));
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const slot = document.querySelector("[data-legal-auth-slot]");
    if (!slot) return;
    bootstrapAuthSlot(slot);
  });
})();
