// Shared primitives used across TransLay landing page
const { useState, useEffect, useRef, useMemo, useCallback } = React;
const SUPPORT_EMAIL = "support@example.com";
const SUPPORT_SUBJECT = "TransLay Support Needed";

function getSupportMailtoHref() {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUPPORT_SUBJECT)}`;
}

// ============ i18n hook ============
function getBrowserLang() {
  const lang = (navigator.language || "en").toLowerCase();
  if (lang.startsWith("zh")) return lang.includes("tw") || lang.includes("hk") ? "zh-TW" : "zh";
  const base = lang.split("-")[0];
  const supported = ["en","fr","de","it","es","pt","ru","nl","sv","el","ar","he","ja","ko"];
  return supported.includes(base) ? base : "en";
}

function useI18n() {
  const [lang, setLang] = useState(() => {
    const stored = localStorage.getItem("translay.lang") || "system";
    return stored;
  });
  const actualLang = lang === "system" ? getBrowserLang() : lang;
  const t = useMemo(() => {
    const base = window.TRANSLATIONS.en || {};
    const current = window.TRANSLATIONS[actualLang] || {};

    function mergeObjects(baseValue, currentValue) {
      if (
        !baseValue
        || typeof baseValue !== "object"
        || Array.isArray(baseValue)
        || !currentValue
        || typeof currentValue !== "object"
        || Array.isArray(currentValue)
      ) {
        return currentValue === undefined ? baseValue : currentValue;
      }

      const merged = { ...baseValue };
      for (const key of Object.keys(currentValue)) {
        merged[key] = mergeObjects(baseValue[key], currentValue[key]);
      }
      return merged;
    }

    return mergeObjects(base, current);
  }, [actualLang]);

  useEffect(() => {
    document.documentElement.lang = actualLang;
    document.documentElement.dir = window.RTL_LANGS.has(actualLang) ? "rtl" : "ltr";
  }, [actualLang]);

  const change = useCallback((l) => {
    setLang(l);
    localStorage.setItem("translay.lang", l);
  }, []);
  return { lang, actualLang, t, setLang: change };
}

// ============ Theme hook ============
function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem("translay.theme") || "system");
  useEffect(() => {
    const apply = () => {
      const mode = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : theme;
      document.documentElement.setAttribute("data-theme", mode);
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
  const change = useCallback((th) => {
    setTheme(th);
    localStorage.setItem("translay.theme", th);
  }, []);
  return { theme, setTheme: change };
}

// ============ Reveal on scroll ============
function Reveal({ children, delay = 0, as: Tag = "div", className = "", ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // If already in viewport at mount, show immediately
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setTimeout(() => el.classList.add("in"), delay);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { setTimeout(() => el.classList.add("in"), delay); io.unobserve(el); }
      });
    }, { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);
  return <Tag ref={ref} className={`reveal ${className}`} {...rest}>{children}</Tag>;
}

// ============ Animated background ============
function AnimatedBG() {
  return (
    <>
      <div className="bg-stage" aria-hidden>
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
        <div className="blob b4" />
      </div>
      <div className="grain" aria-hidden />
    </>
  );
}

// ============ Brand mark ============
function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <img className="brand-mark-image" src="assets/TransLay-logo_48px.png" alt="" />
    </span>
  );
}

function AccountShell({ t, authState, onGoogleCredential, onLogout }) {
  const buttonSlotRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (authState.status !== "signed_out") {
      return;
    }

    const slot = buttonSlotRef.current;
    if (!slot) {
      return;
    }

    let cancelled = false;
    slot.innerHTML = "";
    window.TransLayLandingAuth
      .mountGoogleButton({
        container: slot,
        locale: document.documentElement.lang || "en",
        onCredential: async (credential) => {
          if (cancelled) return;
          await onGoogleCredential(credential);
        },
      })
      .catch((error) => {
        if (cancelled) return;
        slot.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" disabled>${t.auth.google_client_missing}</button>`;
        console.warn("Google sign-in button mount failed:", error?.message || error);
      });

    return () => {
      cancelled = true;
      slot.innerHTML = "";
    };
  }, [authState.status, onGoogleCredential, t.auth.google_client_missing]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onDocumentClick = (event) => {
      if (!event.target.closest(".account-shell")) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [menuOpen]);

  if (authState.status === "loading" || authState.status === "consuming_ticket" || authState.status === "signing_in") {
    const label = authState.status === "consuming_ticket"
      ? t.auth.consuming_ticket
      : authState.status === "signing_in"
        ? t.auth.signing_in
        : t.auth.loading;
    return <div className="auth-status-chip">{label}</div>;
  }

  if (authState.status === "signed_out") {
    return <div className="google-signin-slot" ref={buttonSlotRef} />;
  }

  const user = authState.user;
  const displayName = user?.displayName || user?.email || "Account";
  const avatarUrl = user?.avatarUrl || "";

  return (
    <div className="account-shell">
      <button
        className="account-trigger"
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((open) => !open)}
      >
        {avatarUrl ? (
          <img className="account-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="account-avatar account-avatar-fallback">{displayName.slice(0, 1).toUpperCase()}</span>
        )}
        <svg className="account-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menuOpen ? (
        <div className="account-menu">
          <div className="account-menu-name">{displayName}</div>
          <div className="account-menu-email">{user?.email || displayName}</div>
          <button className="account-menu-action" type="button" onClick={onLogout}>
            {t.auth.sign_out}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SettingsDropdown({ theme, setTheme, lang, setLang, t }) {
  const [open, setOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);

  const languageLabel = useMemo(() => {
    const matched = window.LANG_LIST.find((item) => item.code === lang);
    if (!matched || matched.code === "system") {
      return t.settings.system;
    }
    return matched.name;
  }, [lang, t.settings.system]);

  useEffect(() => {
    if (!open) {
      setLanguageMenuOpen(false);
      return;
    }

    const onDocumentClick = (event) => {
      if (!event.target.closest(".lang-selector")) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [open]);

  return (
    <div className="lang-selector">
      <button
        className="lang-btn"
        type="button"
        aria-label={t.settings.title}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="settings-icon-image" viewBox="0 -960 960 960" aria-hidden="true">
          <path d="M363.07-71.87 346.59-202.5q-11.09-4.28-21.04-10.33-9.94-6.04-19.51-12.84l-121.39 51.19L67.48-377.39l104.91-79.44q-.76-6.04-.76-11.58v-23.18q0-5.54.76-11.58L67.48-582.61l117.17-202.43 121.87 50.95q9.57-6.8 19.65-12.73 10.09-5.92 20.42-10.2l16.48-131.11h233.86l16.48 131.11q11.09 4.28 21.04 10.2 9.94 5.93 19.51 12.73l121.39-50.95 117.17 202.43-105.15 79.44q.76 6.04.76 11.58V-480q0 6.04-.12 11.59-.12 5.54-1.64 11.58l105.15 79.44-117.41 202.91-120.63-51.19q-9.57 6.8-19.65 12.84-10.09 6.05-20.42 10.33L596.93-71.87H363.07Zm79.56-91h73.5l14.24-105.52q31.24-8 58.34-23.62 27.09-15.62 49.09-38.58l98.77 41 36.13-63.69-85.29-64.52q5-14.48 7.24-30.22 2.24-15.74 2.24-31.98 0-16.24-2.24-31.98-2.24-15.74-7.24-30.22l85.76-64.52-36.6-63.69-98.53 42q-22-23.72-49.09-39.58-27.1-15.86-58.58-23.62l-13-105.52h-73.98l-13.52 105.28q-31.72 7.76-58.94 23.62-27.21 15.86-49.45 38.82l-98.28-41-36.37 63.69 85.04 63.29q-5 15.47-7.24 30.83-2.24 15.36-2.24 32.6 0 16.24 2.24 31.72t7.24 30.95l-85.04 64.05 36.37 63.69 98.28-41.76q22.24 23.48 49.57 39.34 27.34 15.86 58.82 23.86l12.76 105.28ZM481.28-340q58 0 99-41t41-99q0-58-41-99t-99-41q-58.76 0-99.38 41t-40.62 99q0 58 40.62 99t99.38 41Z" />
        </svg>
      </button>
      <div className={`lang-dropdown ${open ? "show" : ""}`} role="menu">
        <div className="lang-dropdown-section">
          <div className="lang-dropdown-label">{t.settings.theme}</div>
          <div className="theme-switcher-container">
            <div className="settings-segmented-control" role="group" aria-label={t.settings.theme}>
              <div className={`settings-segmented-thumb settings-segmented-thumb--${theme}`} aria-hidden="true" />
              {[
                {
                  key: "light",
                  label: t.settings.light,
                  icon: (
                    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
                      <path d="M22 29c1.93 0 3.58-.68 4.95-2.05S29 23.93 29 22s-.68-3.58-2.05-4.95S23.93 15 22 15s-3.58.68-4.95 2.05S15 20.07 15 22s.68 3.58 2.05 4.95S20.07 29 22 29Zm0 3c-2.77 0-5.13-.98-7.08-2.93S12 24.77 12 22s.98-5.13 2.92-7.08S19.23 12 22 12s5.13.98 7.08 2.92S32 19.23 32 22s-.98 5.13-2.92 7.07S24.77 32 22 32ZM8 23.5H0v-3h8v3Zm36 0h-8v-3h8v3ZM20.5 8V0h3v8h-3Zm0 36v-8h3v8h-3ZM11.1 13.1l-5-4.85 2.15-2.2 4.8 5-1.95 2.05Zm24.7 24.8-4.9-5 2.05-2.05 4.95 4.9-2.1 2.15Zm-4.95-26.85 4.9-4.95 2.2 2.1-4.95 4.9-2.15-2.05ZM6.1 35.75l4.95-4.9 2.1 2.1-4.9 4.95-2.15-2.15Z" />
                    </svg>
                  ),
                },
                {
                  key: "dark",
                  label: t.settings.dark,
                  icon: (
                    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
                      <path d="M18 36c-5 0-9.25-1.75-12.75-5.25S0 23 0 18 1.75 8.75 5.25 5.25 13 0 18 0c.27 0 .55 0 .85.03s.68.04 1.15.08c-1.2 1.07-2.13 2.38-2.8 3.95s-1 3.22-1 4.95c0 3 1.05 5.55 3.15 7.65s4.65 3.15 7.65 3.15c1.73 0 3.38-.31 4.95-.93s2.88-1.48 3.95-2.58c.03.4.06.73.08.98s.03.49.03.73c0 5-1.75 9.25-5.25 12.75S23 36 18 36Zm0-3c3.63 0 6.8-1.13 9.5-3.38s4.38-4.89 5.05-7.93c-.83.37-1.73.64-2.68.83-.96.18-1.91.28-2.87.28-3.82 0-7.08-1.34-9.77-4.03-2.69-2.69-4.03-5.94-4.03-9.77 0-.8.08-1.66.25-2.58s.47-1.96.9-3.13c-3.27.9-5.98 2.73-8.13 5.48S3 14.6 3 18c0 4.17 1.46 7.71 4.38 10.63C10.29 31.54 13.83 33 18 33Z" />
                    </svg>
                  ),
                },
                {
                  key: "system",
                  label: t.settings.system,
                  icon: (
                    <svg viewBox="0 0 48 34" fill="none" aria-hidden="true">
                      <path d="M0 34v-3h7.05v-2.1c-.8 0-1.5-.3-2.1-.9s-.9-1.3-.9-2.1V3c0-.8.3-1.5.9-2.1S6.25 0 7.05 0h33.9c.8 0 1.5.3 2.1.9s.9 1.3.9 2.1v22.9c0 .8-.3 1.5-.9 2.1s-1.3.9-2.1.9v2.1H48v3H0ZM7.05 25.9h33.9V3H7.05v22.9Z" />
                    </svg>
                  ),
                },
              ].map((item) => (
                <button
                  key={item.key}
                  className={`settings-segmented-option ${theme === item.key ? "active" : ""}`}
                  type="button"
                  aria-pressed={theme === item.key}
                  onClick={() => setTheme(item.key)}
                  title={item.label}
                >
                  {item.icon}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="lang-dropdown-divider" />
        <div className="lang-dropdown-section">
          <div className="lang-dropdown-label">{t.settings.language || "Language"}</div>
          <div className={`settings-language ${languageMenuOpen ? "is-open" : ""}`}>
            <button
              type="button"
              className="settings-language-trigger"
              aria-expanded={languageMenuOpen}
              onClick={() => setLanguageMenuOpen((value) => !value)}
            >
              <span>{languageLabel}</span>
              <span className="settings-language-arrow" aria-hidden="true">▼</span>
            </button>
            <div className="settings-language-menu">
              {window.LANG_LIST.map((item) => (
                <button
                  key={item.code}
                  className={`settings-language-option ${lang === item.code ? "is-active" : ""}`}
                  type="button"
                  onClick={() => {
                    setLang(item.code);
                    setLanguageMenuOpen(false);
                    setOpen(false);
                  }}
                >
                  {item.code === "system" ? t.settings.system : item.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ Top bar ============
function TopBar({ t, theme, setTheme, lang, setLang, authState, onGoogleCredential, onLogout }) {
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <a className="brand" href="/">
          <BrandMark />
          <span>TransLay</span>
        </a>
        <nav className="nav-links" aria-label="Primary">
          <a className="nav-link" href="#features">{t.nav.features}</a>
          <a className="nav-link" href="#pricing">{t.nav.pricing}</a>
          <a className="nav-link" href="#faq">{t.nav.faq}</a>
          <a className="nav-link btn btn-primary btn-sm keep nav-install-btn" href="#install">
            {t.nav.install}
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </a>
        </nav>
        <div className="topbar-actions">
          <AccountShell
            t={t}
            authState={authState}
            onGoogleCredential={onGoogleCredential}
            onLogout={onLogout}
          />
          <SettingsDropdown theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} t={t} />
        </div>
      </div>
    </header>
  );
}

// ============ Footer ============
function Footer({ t }) {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-bottom footer-bottom-single">
          <div className="footer-left-group">
            <a className="brand footer-brand" href="/"><BrandMark /><span>TransLay</span></a>
            <div>{t.footer.copyright}</div>
            <a className="footer-support-link" href={getSupportMailtoHref()}>{SUPPORT_EMAIL}</a>
          </div>
          <div className="footer-legal">
            <a href="/terms">{t.footer.terms}</a>
            <a href="/privacy">{t.footer.privacy}</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, {
  SUPPORT_EMAIL, SUPPORT_SUBJECT, getSupportMailtoHref, useI18n, useTheme, getBrowserLang, Reveal, AnimatedBG, BrandMark, AccountShell, SettingsDropdown, TopBar, Footer,
});
