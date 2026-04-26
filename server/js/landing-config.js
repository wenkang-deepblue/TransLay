(() => {
  const GOOGLE_CLIENT_ID_META = "translay-google-client-id";
  let publicConfig = {
    googleWebClientId: "",
    billingProvider: "",
    paddleEnvironment: "sandbox",
    paddleClientToken: "",
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
          if (typeof payload?.billing_provider === "string") {
            publicConfig.billingProvider = payload.billing_provider.trim();
          }
          if (typeof payload?.paddle_environment === "string") {
            publicConfig.paddleEnvironment = payload.paddle_environment.trim() || "sandbox";
          }
          if (typeof payload?.paddle_client_token === "string") {
            publicConfig.paddleClientToken = payload.paddle_client_token.trim();
          }
          const slidesCreditSku = payload?.credit_skus?.slides;
          if (slidesCreditSku && typeof slidesCreditSku === "object") {
            publicConfig.creditSkus.slides = {
              minUnits:
                Number.isInteger(slidesCreditSku.min_units) && slidesCreditSku.min_units > 0
                  ? slidesCreditSku.min_units
                  : publicConfig.creditSkus.slides.minUnits,
              maxUnits:
                Number.isInteger(slidesCreditSku.max_units) && slidesCreditSku.max_units > 0
                  ? slidesCreditSku.max_units
                  : publicConfig.creditSkus.slides.maxUnits,
              amountCents:
                Number.isInteger(slidesCreditSku.amount_cents) && slidesCreditSku.amount_cents > 0
                  ? slidesCreditSku.amount_cents
                  : publicConfig.creditSkus.slides.amountCents,
              minimumChargeAmountCents:
                Number.isInteger(slidesCreditSku.minimum_charge_amount_cents) &&
                slidesCreditSku.minimum_charge_amount_cents > 0
                  ? slidesCreditSku.minimum_charge_amount_cents
                  : publicConfig.creditSkus.slides.minimumChargeAmountCents,
            };
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
    getBillingProvider() {
      return publicConfig.billingProvider;
    },
    getPaddleEnvironment() {
      return publicConfig.paddleEnvironment || "sandbox";
    },
    getPaddleClientToken() {
      return publicConfig.paddleClientToken;
    },
    getCreditSku(sku) {
      return publicConfig.creditSkus[sku] || null;
    },
  };
})();
