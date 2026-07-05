(() => {
  const GOOGLE_CLIENT_ID_META = "translay-google-client-id";
  let publicConfig = {
    googleWebClientId: "",
    creditSkus: {
      slides: {
        minUnits: 18,
        maxUnits: 100,
        amountCents: 4,
        minimumChargeAmountCents: 70,
      },
    },
  };
  let loadPromise = null;

  function readMetaContent(name) {
    const node = document.querySelector(`meta[name="${name}"]`);
    const value = typeof node?.content === "string" ? node.content.trim() : "";
    return value;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return {};
    }
  }

  async function loadPublicConfig() {
    if (loadPromise) {
      return loadPromise;
    }

    loadPromise = (async () => {
      const metaClientId = readMetaContent(GOOGLE_CLIENT_ID_META);
      if (metaClientId) {
        publicConfig.googleWebClientId = metaClientId;
        return publicConfig;
      }

      try {
        const response = await fetch("/api/public/landing-config", {
          credentials: "same-origin",
        });
        const payload = await readJson(response);
        if (response.ok) {
          if (typeof payload?.google_web_client_id === "string") {
            publicConfig.googleWebClientId = payload.google_web_client_id.trim();
          }
        }
      } catch (_) {
        // Keep graceful fallback to empty config.
      }

      return publicConfig;
    })();

    return loadPromise;
  }

  window.TransLayLandingConfig = {
    apiBaseUrl: "/api",
    load: loadPublicConfig,
    getGoogleClientId() {
      return publicConfig.googleWebClientId || readMetaContent(GOOGLE_CLIENT_ID_META);
    },
    getCreditSku(sku) {
      return publicConfig.creditSkus[sku] || null;
    },
  };
})();
