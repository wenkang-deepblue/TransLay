import test from "node:test";
import assert from "node:assert/strict";
import { __redactAuthTokenFromErrorForTests } from "./auth";

test("auth token verification logging redacts raw invalid token values", () => {
  const token = "translay-round-2-probe-invalid-user-oauth-token";
  const message = __redactAuthTokenFromErrorForTests(
    new Error(`Wrong number of segments in token: ${token}`),
    token
  );

  assert.equal(message, "Wrong number of segments in token: [redacted-token]");
  assert.doesNotMatch(message, /translay-round-2-probe-invalid-user-oauth-token/);
});

test("auth token verification logging redacts token-shaped fallbacks", () => {
  const message = __redactAuthTokenFromErrorForTests(
    new Error("Rejected ya29.secret-token and aaa.bbb.ccc"),
    "different-token"
  );

  assert.equal(message, "Rejected ya29.[redacted] and [redacted-jwt]");
});
