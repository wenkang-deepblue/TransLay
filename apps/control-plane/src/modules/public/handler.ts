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
    });
  };
}
