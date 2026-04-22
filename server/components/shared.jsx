// Shared primitives used across TransLay landing page
const { useState, useEffect, useRef, useMemo, useCallback } = React;

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
  const t = useMemo(() => window.TRANSLATIONS[actualLang] || window.TRANSLATIONS.en, [actualLang]);

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
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M5 7h6M8 5v2M6 13l4-6 4 6" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M12 17l3-3 4 4 3-3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.7"/>
      </svg>
    </span>
  );
}

function getPlanLabel(t, planType) {
  return planType === "free" ? t.auth.plan_free : t.auth.plan_paid;
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
  const planLabel = getPlanLabel(t, authState.planType);

  return (
    <div className="account-shell">
      <button className="account-trigger" type="button" onClick={() => setMenuOpen((open) => !open)}>
        {avatarUrl ? (
          <img className="account-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="account-avatar account-avatar-fallback">{displayName.slice(0, 1).toUpperCase()}</span>
        )}
        <span className="account-copy">
          <span className="account-name">{displayName}</span>
          <span className="account-plan">{planLabel}</span>
        </span>
      </button>
      {menuOpen ? (
        <div className="account-menu">
          <div className="account-menu-label">{t.auth.signed_in_as}</div>
          <div className="account-menu-email">{user?.email || displayName}</div>
          <button className="account-menu-action" type="button" onClick={onLogout}>
            {t.auth.sign_out}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ============ Top bar ============
function TopBar({ t, onOpenSettings, authState, onGoogleCredential, onLogout }) {
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <a className="brand" href="/">
          <BrandMark />
          <span>TransLay</span>
        </a>
        <nav className="nav-links">
          <a className="nav-link" href="#features">{t.nav.features}</a>
          <a className="nav-link" href="#pricing">{t.nav.pricing}</a>
          <a className="nav-link" href="#faq">{t.nav.faq}</a>
          <a className="nav-link btn btn-primary btn-sm keep" style={{color: "white", marginLeft: 6}} href="#install">
            {t.nav.install}
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </a>
          <AccountShell
            t={t}
            authState={authState}
            onGoogleCredential={onGoogleCredential}
            onLogout={onLogout}
          />
          <button className="icon-btn" aria-label="Settings" onClick={onOpenSettings} style={{marginInlineStart: 8}}>
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7"/>
              <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 003.6 8a1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1A1.7 1.7 0 0014 3.6a1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V8a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
        </nav>
      </div>
    </header>
  );
}

// ============ Settings modal ============
function SettingsModal({ open, onClose, theme, setTheme, lang, setLang, t }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div className={`settings-overlay ${open ? "open" : ""}`} onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <h3 className="settings-h">
          {t.settings.title}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          </button>
        </h3>
        <div className="settings-label">{t.settings.theme}</div>
        <div className="seg">
          {[
            { k: "light", l: t.settings.light },
            { k: "dark", l: t.settings.dark },
            { k: "system", l: t.settings.system },
          ].map(o => (
            <button key={o.k} className={theme === o.k ? "active" : ""} onClick={() => setTheme(o.k)}>{o.l}</button>
          ))}
        </div>
        <div className="settings-label">{t.settings.language}</div>
        <select className="lang-select" value={lang} onChange={e => setLang(e.target.value)}>
          {window.LANG_LIST.map(l => (
            <option key={l.code} value={l.code}>
              {l.code === "system" ? `${t.settings.system}` : l.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ============ Footer ============
function Footer({ t }) {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div style={{maxWidth: 340}}>
            <a className="brand" href="/"><BrandMark /><span>TransLay</span></a>
            <p style={{color: "var(--text-soft)", marginTop: 14, fontSize: 14, lineHeight: 1.6}}>{t.footer.tagline}</p>
          </div>
        </div>
        <div className="footer-bottom">
          <div>{t.footer.copyright}</div>
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
  useI18n, useTheme, getBrowserLang, Reveal, AnimatedBG, BrandMark, TopBar, SettingsModal, Footer,
});
