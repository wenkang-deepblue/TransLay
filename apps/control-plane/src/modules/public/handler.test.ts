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
  });
  assert.equal(cacheControl, "public, max-age=300");
});
