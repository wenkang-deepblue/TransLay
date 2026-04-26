import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import type { AppConfig } from "@translay/shared-config";
import { landingConfigHandler } from "./handler";

test("landingConfigHandler returns the public Google Web client ID", () => {
  const config = {
    publicAuth: {
      googleWebClientId: "1234567890-example.apps.googleusercontent.com",
    },
    billing: {
      providerName: "paddle",
      paddle: {
        environment: "sandbox",
        clientToken: "test_client_token",
        apiKey: "pdl_test_api_key",
        creditSkus: {
          slides: {
            minUnits: 18,
            maxUnits: 100,
            amountCents: 4,
            minimumChargeAmountCents: 70,
          },
        },
      },
    },
  } as unknown as AppConfig;

  let body: unknown = null;
  let cacheControl = "";
  const res = {
    setHeader(name: string, value: string) {
      if (name === "Cache-Control") {
        cacheControl = value;
      }
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  landingConfigHandler(config)({} as never, res);

  assert.deepEqual(body, {
    google_web_client_id: "1234567890-example.apps.googleusercontent.com",
    billing_provider: "paddle",
    paddle_environment: "sandbox",
    paddle_client_token: "test_client_token",
    credit_skus: {
      slides: {
        min_units: 18,
        max_units: 100,
        amount_cents: 4,
        minimum_charge_amount_cents: 70,
      },
    },
  });
  assert.equal(cacheControl, "public, max-age=300");
});
