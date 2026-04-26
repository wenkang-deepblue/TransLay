import type { Request, Response } from "express";
import type { AppConfig } from "@translay/shared-config";

export function landingConfigHandler(config: AppConfig) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      google_web_client_id: config.publicAuth.googleWebClientId,
      billing_provider: config.billing.providerName,
      paddle_environment: config.billing.paddle.environment,
      paddle_client_token: config.billing.paddle.clientToken,
      credit_skus: {
        slides: {
          min_units: config.billing.paddle.creditSkus.slides.minUnits,
          max_units: config.billing.paddle.creditSkus.slides.maxUnits,
          amount_cents: config.billing.paddle.creditSkus.slides.amountCents,
          minimum_charge_amount_cents:
            config.billing.paddle.creditSkus.slides.minimumChargeAmountCents,
        },
      },
    });
  };
}
