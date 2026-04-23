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

  function getStoredLang() {
    return localStorage.getItem("translay.lang") || "system";
  }

  function getResolvedLang() {
    const stored = getStoredLang();
    return stored === "system" ? getBrowserLang() : stored;
  }

  function getStoredTheme() {
    return localStorage.getItem("translay.theme") || "system";
  }

  function applyTheme(theme) {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
  }

  function applyLang(lang) {
    const resolved = lang === "system" ? getBrowserLang() : lang;
    document.documentElement.lang = resolved;
    document.documentElement.dir = window.RTL_LANGS?.has(resolved) ? "rtl" : "ltr";
  }

  function getTranslations() {
    const currentLang = getResolvedLang();
    return (
      window.TRANSLATIONS?.[currentLang] ||
      window.TRANSLATIONS?.[currentLang.split("-")[0]] ||
      window.TRANSLATIONS?.en ||
      { auth: {}, footer: {}, legal: {}, nav: {}, settings: {} }
    );
  }

  function localizeLegalPage() {
    const translations = getTranslations();
    const nav = translations?.nav || {};
    const footer = translations?.footer || {};
    const legal = translations?.legal || {};
    const legalPages = translations?.legalPages || {};

    const assignText = (selector, value) => {
      if (typeof value !== "string" || !value.trim()) {
        return;
      }

      document.querySelectorAll(selector).forEach((node) => {
        node.textContent = value;
      });
    };

    assignText("[data-legal-nav-home]", nav.home || "Home");
    assignText("[data-legal-nav-features]", nav.features);
    assignText("[data-legal-nav-pricing]", nav.pricing);
    assignText("[data-legal-nav-faq]", nav.faq);
    assignText("[data-legal-nav-install]", nav.install);
    assignText("[data-legal-footer-terms]", footer.terms);
    assignText("[data-legal-footer-privacy]", footer.privacy);
    assignText("[data-legal-footer-copyright]", footer.copyright);
    assignText("[data-legal-back-home]", legal.back_home);

    const documentRoot = document.querySelector("[data-legal-document]");
    const page = documentRoot?.getAttribute("data-legal-page");
    const doc = page ? legalPages?.[page] : null;
    if (!documentRoot || !doc) {
      return;
    }

    const introHtml = Array.isArray(doc.intro)
      ? doc.intro.map((paragraph) => `<p>${paragraph}</p>`).join("")
      : "";
    const sectionsHtml = Array.isArray(doc.sections)
      ? doc.sections.map((section) => {
        const paragraphs = Array.isArray(section.paragraphs)
          ? section.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")
          : "";
        return `<h2>${section.title || ""}</h2>${paragraphs}`;
      }).join("")
      : "";

    documentRoot.innerHTML = `
      <h1>${doc.title || ""}</h1>
      <div class="meta">${doc.last_updated || ""}</div>
      ${introHtml}
      ${sectionsHtml}
    `;
    if (typeof doc.title === "string" && doc.title.trim()) {
      document.title = doc.title;
    }
  }

  function buildSignedInMarkup(state, translations) {
    const displayName = state.user?.displayName || state.user?.email || "Account";
    const email = state.user?.email || displayName;
    const avatarUrl = state.user?.avatarUrl || "";

    const avatarHtml = avatarUrl
      ? `<img class="account-avatar" src="${createEscapedText(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="account-avatar account-avatar-fallback">${createEscapedText(displayName.slice(0, 1).toUpperCase())}</span>`;

    return `
      <div class="account-shell">
        <button class="account-trigger" type="button" data-legal-account-trigger aria-expanded="false" aria-haspopup="menu">
          ${avatarHtml}
          <svg class="account-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </button>
        <div class="account-menu" data-legal-account-menu hidden>
          <div class="account-menu-name">${createEscapedText(displayName)}</div>
          <div class="account-menu-email">${createEscapedText(email)}</div>
          <button class="account-menu-action" type="button" data-legal-logout>${createEscapedText(translations?.auth?.sign_out || "Sign out")}</button>
        </div>
      </div>
    `;
  }

  function buildLoadingMarkup(message) {
    return `<div class="auth-status-chip">${createEscapedText(message)}</div>`;
  }

  function getLanguageLabel(lang, translations) {
    const matched = (window.LANG_LIST || []).find((item) => item.code === lang);
    if (!matched || matched.code === "system") {
      return translations?.settings?.system || "System";
    }
    return matched.name;
  }

  function buildSettingsMarkup(theme, lang, translations) {
    const languageItems = (window.LANG_LIST || []).map((item) => `
      <button
        class="settings-language-option ${lang === item.code ? "is-active" : ""}"
        type="button"
        data-settings-lang="${createEscapedText(item.code)}"
      >
        ${createEscapedText(item.code === "system" ? (translations?.settings?.system || "System") : item.name)}
      </button>
    `).join("");

    const themes = [
      {
        key: "light",
        label: translations?.settings?.light || "Light",
        icon: `<svg viewBox="0 0 44 44" fill="none" aria-hidden="true"><path d="M22 29c1.93 0 3.58-.68 4.95-2.05S29 23.93 29 22s-.68-3.58-2.05-4.95S23.93 15 22 15s-3.58.68-4.95 2.05S15 20.07 15 22s.68 3.58 2.05 4.95S20.07 29 22 29Zm0 3c-2.77 0-5.13-.98-7.08-2.93S12 24.77 12 22s.98-5.13 2.92-7.08S19.23 12 22 12s5.13.98 7.08 2.92S32 19.23 32 22s-.98 5.13-2.92 7.07S24.77 32 22 32ZM8 23.5H0v-3h8v3Zm36 0h-8v-3h8v3ZM20.5 8V0h3v8h-3Zm0 36v-8h3v8h-3ZM11.1 13.1l-5-4.85 2.15-2.2 4.8 5-1.95 2.05Zm24.7 24.8-4.9-5 2.05-2.05 4.95 4.9-2.1 2.15Zm-4.95-26.85 4.9-4.95 2.2 2.1-4.95 4.9-2.15-2.05ZM6.1 35.75l4.95-4.9 2.1 2.1-4.9 4.95-2.15-2.15Z"/></svg>`,
      },
      {
        key: "dark",
        label: translations?.settings?.dark || "Dark",
        icon: `<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M18 36c-5 0-9.25-1.75-12.75-5.25S0 23 0 18 1.75 8.75 5.25 5.25 13 0 18 0c.27 0 .55 0 .85.03s.68.04 1.15.08c-1.2 1.07-2.13 2.38-2.8 3.95s-1 3.22-1 4.95c0 3 1.05 5.55 3.15 7.65s4.65 3.15 7.65 3.15c1.73 0 3.38-.31 4.95-.93s2.88-1.48 3.95-2.58c.03.4.06.73.08.98s.03.49.03.73c0 5-1.75 9.25-5.25 12.75S23 36 18 36Zm0-3c3.63 0 6.8-1.13 9.5-3.38s4.38-4.89 5.05-7.93c-.83.37-1.73.64-2.68.83-.96.18-1.91.28-2.87.28-3.82 0-7.08-1.34-9.77-4.03-2.69-2.69-4.03-5.94-4.03-9.77 0-.8.08-1.66.25-2.58s.47-1.96.9-3.13c-3.27.9-5.98 2.73-8.13 5.48S3 14.6 3 18c0 4.17 1.46 7.71 4.38 10.63C10.29 31.54 13.83 33 18 33Z"/></svg>`,
      },
      {
        key: "system",
        label: translations?.settings?.system || "System",
        icon: `<svg viewBox="0 0 48 34" fill="none" aria-hidden="true"><path d="M0 34v-3h7.05v-2.1c-.8 0-1.5-.3-2.1-.9s-.9-1.3-.9-2.1V3c0-.8.3-1.5.9-2.1S6.25 0 7.05 0h33.9c.8 0 1.5.3 2.1.9s.9 1.3.9 2.1v22.9c0 .8-.3 1.5-.9 2.1s-1.3.9-2.1.9v2.1H48v3H0ZM7.05 25.9h33.9V3H7.05v22.9Z"/></svg>`,
      },
    ].map((item) => `
      <button
        class="settings-segmented-option ${theme === item.key ? "active" : ""}"
        type="button"
        data-settings-theme="${createEscapedText(item.key)}"
        title="${createEscapedText(item.label)}"
        aria-pressed="${theme === item.key ? "true" : "false"}"
      >
        ${item.icon}
      </button>
    `).join("");

    return `
      <div class="lang-selector">
        <button
          class="lang-btn"
          type="button"
          data-legal-settings-trigger
          aria-label="${createEscapedText(translations?.settings?.title || "Settings")}"
          aria-expanded="false"
        >
          <svg class="settings-icon-image" viewBox="0 -960 960 960" aria-hidden="true">
            <path d="M363.07-71.87 346.59-202.5q-11.09-4.28-21.04-10.33-9.94-6.04-19.51-12.84l-121.39 51.19L67.48-377.39l104.91-79.44q-.76-6.04-.76-11.58v-23.18q0-5.54.76-11.58L67.48-582.61l117.17-202.43 121.87 50.95q9.57-6.8 19.65-12.73 10.09-5.92 20.42-10.2l16.48-131.11h233.86l16.48 131.11q11.09 4.28 21.04 10.2 9.94 5.93 19.51 12.73l121.39-50.95 117.17 202.43-105.15 79.44q.76 6.04.76 11.58V-480q0 6.04-.12 11.59-.12 5.54-1.64 11.58l105.15 79.44-117.41 202.91-120.63-51.19q-9.57 6.8-19.65 12.84-10.09 6.05-20.42 10.33L596.93-71.87H363.07Zm79.56-91h73.5l14.24-105.52q31.24-8 58.34-23.62 27.09-15.62 49.09-38.58l98.77 41 36.13-63.69-85.29-64.52q5-14.48 7.24-30.22 2.24-15.74 2.24-31.98 0-16.24-2.24-31.98-2.24-15.74-7.24-30.22l85.76-64.52-36.6-63.69-98.53 42q-22-23.72-49.09-39.58-27.1-15.86-58.58-23.62l-13-105.52h-73.98l-13.52 105.28q-31.72 7.76-58.94 23.62-27.21 15.86-49.45 38.82l-98.28-41-36.37 63.69 85.04 63.29q-5 15.47-7.24 30.83-2.24 15.36-2.24 32.6 0 16.24 2.24 31.72t7.24 30.95l-85.04 64.05 36.37 63.69 98.28-41.76q22.24 23.48 49.57 39.34 27.34 15.86 58.82 23.86l12.76 105.28ZM481.28-340q58 0 99-41t41-99q0-58-41-99t-99-41q-58.76 0-99.38 41t-40.62 99q0 58 40.62 99t99.38 41Z"></path>
          </svg>
        </button>
        <div class="lang-dropdown" data-legal-settings-menu hidden>
          <div class="lang-dropdown-section">
            <div class="lang-dropdown-label">${createEscapedText(translations?.settings?.theme || "Theme")}</div>
            <div class="theme-switcher-container">
              <div class="settings-segmented-control" role="group" aria-label="${createEscapedText(translations?.settings?.theme || "Theme")}">
                <div class="settings-segmented-thumb settings-segmented-thumb--${createEscapedText(theme)}" aria-hidden="true"></div>
                ${themes}
              </div>
            </div>
          </div>
          <div class="lang-dropdown-divider"></div>
          <div class="lang-dropdown-section">
            <div class="lang-dropdown-label">${createEscapedText(translations?.settings?.language || "Language")}</div>
            <div class="settings-language" data-legal-language-menu>
              <button type="button" class="settings-language-trigger" data-legal-language-trigger aria-expanded="false">
                <span>${createEscapedText(getLanguageLabel(lang, translations))}</span>
                <span class="settings-language-arrow" aria-hidden="true">▼</span>
              </button>
              <div class="settings-language-menu">
                ${languageItems}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function bindSettingsSlot(slot) {
    if (!slot) return;
    slot.__cleanupSettingsOutsideClick?.();
    slot.__cleanupSettingsOutsideClick = null;

    const theme = getStoredTheme();
    const lang = getStoredLang();
    const translations = getTranslations();
    slot.innerHTML = buildSettingsMarkup(theme, lang, translations);

    const trigger = slot.querySelector("[data-legal-settings-trigger]");
    const menu = slot.querySelector("[data-legal-settings-menu]");
    const languageWrap = slot.querySelector("[data-legal-language-menu]");
    const languageTrigger = slot.querySelector("[data-legal-language-trigger]");
    const langButtons = Array.from(slot.querySelectorAll("[data-settings-lang]"));
    const themeButtons = Array.from(slot.querySelectorAll("[data-settings-theme]"));

    const syncMenuVisibility = (open) => {
      if (!menu || !trigger) return;
      menu.hidden = !open;
      menu.classList.toggle("show", open);
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) {
        languageWrap?.classList.remove("is-open");
        languageTrigger?.setAttribute("aria-expanded", "false");
      }
    };

    trigger?.addEventListener("click", () => {
      const shouldOpen = menu?.hidden !== false;
      syncMenuVisibility(shouldOpen);
    });

    languageTrigger?.addEventListener("click", () => {
      const shouldOpen = !languageWrap?.classList.contains("is-open");
      languageWrap?.classList.toggle("is-open", shouldOpen);
      languageTrigger.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    });

    const onDocumentClick = (event) => {
      if (slot.contains(event.target)) return;
      syncMenuVisibility(false);
    };
    document.addEventListener("click", onDocumentClick);
    slot.__cleanupSettingsOutsideClick = () => document.removeEventListener("click", onDocumentClick);

    langButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const nextLang = button.getAttribute("data-settings-lang") || "system";
        localStorage.setItem("translay.lang", nextLang);
        applyLang(nextLang);
        localizeLegalPage();
        bindSettingsSlot(slot);
        const authSlot = document.querySelector("[data-legal-auth-slot]");
        if (authSlot) {
          const currentState =
            authSlot.__authState ||
            window.TransLayLandingSession.buildSignedOutState("");
          renderAuthSlot(authSlot, currentState);
        }
      });
    });

    themeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const nextTheme = button.getAttribute("data-settings-theme") || "system";
        localStorage.setItem("translay.theme", nextTheme);
        applyTheme(nextTheme);
        bindSettingsSlot(slot);
      });
    });
  }

  async function renderAuthSlot(slot, state) {
    if (!slot) return;
    const translations = getTranslations();
    slot.__authState = state;

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
        trigger.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
      });

      logoutButton?.addEventListener("click", async () => {
        try {
          await window.TransLayLandingSession.logout();
        } catch (error) {
          console.warn("Portal logout failed:", error?.message || error);
        }
        window.TransLayLandingSession.clearAuthSnapshot?.();
        await bootstrapAuthSlot(slot);
      });

      const onDocumentClick = (event) => {
        if (slot.contains(event.target)) return;

        const settingsSlot = document.querySelector("[data-legal-settings-slot]");
        if (settingsSlot?.contains(event.target)) return;

        if (menu && trigger) {
          menu.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
        }

        const settingsMenu = document.querySelector("[data-legal-settings-menu]");
        const settingsTrigger = document.querySelector("[data-legal-settings-trigger]");
        if (settingsMenu && settingsTrigger) {
          settingsMenu.hidden = true;
          settingsMenu.classList.remove("show");
          settingsTrigger.setAttribute("aria-expanded", "false");
        }
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
        locale: getResolvedLang(),
        onCredential: async (credential) => {
          slot.innerHTML = buildLoadingMarkup(
            translations?.auth?.signing_in || "Completing sign-in..."
          );
          try {
            const payload = await window.TransLayLandingSession.loginWithGoogleCredential(credential);
            await renderAuthSlot(slot, window.TransLayLandingSession.rememberSessionState(payload));
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
    const hydratedSnapshot = window.TransLayLandingSession.readAuthSnapshot?.() || null;
    if (hydratedSnapshot?.status === "signed_in") {
      await renderAuthSlot(slot, hydratedSnapshot);
    } else {
      slot.innerHTML = buildLoadingMarkup(
        translations?.auth?.loading || "Checking session..."
      );
    }

    try {
      const payload = await window.TransLayLandingSession.fetchSessionMe();
      const state = window.TransLayLandingSession.normalizeSessionState(payload);
      if (state.status === "signed_in") {
        await renderAuthSlot(slot, window.TransLayLandingSession.rememberSessionState(payload));
        return;
      }

      window.TransLayLandingSession.clearAuthSnapshot?.();
      await renderAuthSlot(slot, state);
    } catch (_) {
      if (hydratedSnapshot?.status === "signed_in") {
        await renderAuthSlot(slot, hydratedSnapshot);
        return;
      }

      await renderAuthSlot(slot, window.TransLayLandingSession.buildSignedOutState(""));
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    applyTheme(getStoredTheme());
    applyLang(getStoredLang());
    localizeLegalPage();

    const authSlot = document.querySelector("[data-legal-auth-slot]");
    const settingsSlot = document.querySelector("[data-legal-settings-slot]");
    if (settingsSlot) bindSettingsSlot(settingsSlot);
    if (authSlot) bootstrapAuthSlot(authSlot);
  });
})();
