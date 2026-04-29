(() => {
  let gisScriptPromise = null;

  function normalizeLocale(rawLocale) {
    const locale = String(rawLocale || "en").trim();
    if (!locale) return "en";
    const normalized = locale.replaceAll("_", "-");
    if (normalized.startsWith("zh")) {
      return normalized.includes("TW") || normalized.includes("HK") ? "zh-TW" : "zh";
    }
    return normalized;
  }

  function loadGoogleIdentityScript() {
    if (gisScriptPromise) {
      return gisScriptPromise;
    }

    gisScriptPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) {
        resolve(window.google.accounts.id);
        return;
      }

      const existingScript = document.querySelector('script[data-translay-gis="1"]');
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(window.google?.accounts?.id));
        existingScript.addEventListener("error", () => reject(new Error("Failed to load Google Identity Services™.")));
        return;
      }

      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.dataset.translayGis = "1";
      script.onload = () => {
        if (!window.google?.accounts?.id) {
          reject(new Error("Google Identity Services™ is unavailable."));
          return;
        }
        resolve(window.google.accounts.id);
      };
      script.onerror = () => reject(new Error("Failed to load Google Identity Services™."));
      document.head.appendChild(script);
    });

    return gisScriptPromise;
  }

  async function mountGoogleButton({ container, onCredential, locale = "en" }) {
    if (!container) {
      throw new Error("Google sign-in container is required.");
    }

    if (typeof window.TransLayLandingConfig?.load === "function") {
      await window.TransLayLandingConfig.load();
    }

    const clientId = window.TransLayLandingConfig?.getGoogleClientId?.() || "";
    if (!clientId) {
      throw new Error("Google Web client ID is not configured.");
    }

    const googleAccounts = await loadGoogleIdentityScript();
    container.innerHTML = "";

    googleAccounts.initialize({
      client_id: clientId,
      callback: (response) => {
        if (!response?.credential) {
          return;
        }

        // Never persist the GIS credential in storage; exchange it for a
        // server-backed HttpOnly session immediately.
        onCredential(response.credential);
      },
      ux_mode: "popup",
      auto_select: false,
      cancel_on_tap_outside: true,
      itp_support: true,
    });

    googleAccounts.renderButton(container, {
      type: "standard",
      theme: "outline",
      size: "large",
      shape: "pill",
      text: "continue_with",
      logo_alignment: "left",
      locale: normalizeLocale(locale),
    });
  }

  window.TransLayLandingAuth = {
    mountGoogleButton,
  };
})();
