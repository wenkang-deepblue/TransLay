import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  __resetSlidesClientForTests,
  __setSlidesAuthHooksForTests,
  __setSlidesClientForTests,
  getSlidesClientForJob,
  isUserTokenAuthError,
} from "./auth";

function createPoolMock(
  row: {
    user_id: string;
    host_oauth_access_token_enc: Buffer | string | null;
    host_oauth_token_expires_at: Date | string | null;
    host_oauth_source: "addon" | "sa_fallback";
  },
  updates: Array<{ jobId: string; source: string }>
): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM translation_jobs")) {
        return { rows: [row] };
      }
      if (sql.includes("SET host_oauth_source")) {
        updates.push({
          jobId: String(params?.[0]),
          source: String(params?.[1]),
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  } as Pool;
}

test("getSlidesClientForJob uses decrypted user OAuth token when it is still valid", async () => {
  const updates: Array<{ jobId: string; source: string }> = [];
  const serviceAccountAuth = { kind: "sa-auth" };
  const serviceAccountSlides = { kind: "sa-slides" };
  const userAuth = { kind: "user-auth" };
  const userSlides = { kind: "user-slides" };

  __setSlidesClientForTests({
    auth: serviceAccountAuth as never,
    slides: serviceAccountSlides as never,
  });

  __setSlidesAuthHooksForTests({
    nowMs: () => Date.parse("2026-04-17T10:00:00.000Z"),
    decryptToken: async (ciphertext) => {
      assert.equal(Buffer.from(ciphertext).toString("utf8"), "token");
      return "decrypted-user-token";
    },
    buildUserSlidesClient: (accessToken) => {
      assert.equal(accessToken, "decrypted-user-token");
      return {
        auth: userAuth as never,
        slides: userSlides as never,
      };
    },
  });

  try {
    const context = await getSlidesClientForJob(
      "job-user-oauth",
      createPoolMock(
        {
          user_id: "user-1",
          host_oauth_access_token_enc: "\\x746f6b656e",
          host_oauth_token_expires_at: "2026-04-17T10:10:00.000Z",
          host_oauth_source: "addon",
        },
        updates
      )
    );

    assert.equal(context.source, "user");
    assert.equal(context.scopeOk, false);
    assert.equal(context.auth, userAuth);
    assert.equal(context.slides, userSlides);
    context.markScopeValidated();
    assert.equal(context.scopeOk, true);
    assert.deepEqual(updates, []);
  } finally {
    __resetSlidesClientForTests();
  }
});

test("fallbackToServiceAccount switches auth context and persists the fallback source", async () => {
  const updates: Array<{ jobId: string; source: string }> = [];
  const serviceAccountAuth = { kind: "sa-auth" };
  const serviceAccountSlides = { kind: "sa-slides" };
  const userAuth = { kind: "user-auth" };
  const userSlides = { kind: "user-slides" };

  __setSlidesClientForTests({
    auth: serviceAccountAuth as never,
    slides: serviceAccountSlides as never,
  });

  __setSlidesAuthHooksForTests({
    nowMs: () => Date.parse("2026-04-17T10:00:00.000Z"),
    decryptToken: async () => "decrypted-user-token",
    buildUserSlidesClient: () => ({
      auth: userAuth as never,
      slides: userSlides as never,
    }),
  });

  try {
    const context = await getSlidesClientForJob(
      "job-fallback",
      createPoolMock(
        {
          user_id: "user-2",
          host_oauth_access_token_enc: Buffer.from("ciphertext"),
          host_oauth_token_expires_at: "2026-04-17T10:10:00.000Z",
          host_oauth_source: "addon",
        },
        updates
      )
    );

    await context.fallbackToServiceAccount("slides_auth_error", new Error("expired token"));

    assert.equal(context.source, "sa_fallback");
    assert.equal(context.scopeOk, false);
    assert.equal(context.auth, serviceAccountAuth);
    assert.equal(context.slides, serviceAccountSlides);
    assert.deepEqual(updates, [{ jobId: "job-fallback", source: "sa_fallback" }]);
  } finally {
    __resetSlidesClientForTests();
  }
});

test("getSlidesClientForJob falls back to service account when token decrypt fails", async () => {
  const updates: Array<{ jobId: string; source: string }> = [];
  const serviceAccountAuth = { kind: "sa-auth" };
  const serviceAccountSlides = { kind: "sa-slides" };

  __setSlidesClientForTests({
    auth: serviceAccountAuth as never,
    slides: serviceAccountSlides as never,
  });

  __setSlidesAuthHooksForTests({
    nowMs: () => Date.parse("2026-04-17T10:00:00.000Z"),
    decryptToken: async () => {
      throw new Error("kms unavailable");
    },
  });

  try {
    const context = await getSlidesClientForJob(
      "job-kms-fallback",
      createPoolMock(
        {
          user_id: "user-3",
          host_oauth_access_token_enc: Buffer.from("ciphertext"),
          host_oauth_token_expires_at: "2026-04-17T10:10:00.000Z",
          host_oauth_source: "addon",
        },
        updates
      )
    );

    assert.equal(context.source, "sa_fallback");
    assert.equal(context.scopeOk, false);
    assert.equal(context.auth, serviceAccountAuth);
    assert.equal(context.slides, serviceAccountSlides);
    assert.deepEqual(updates, [{ jobId: "job-kms-fallback", source: "sa_fallback" }]);
  } finally {
    __resetSlidesClientForTests();
  }
});

test("isUserTokenAuthError does not treat quota 403 responses as auth failures", () => {
  assert.equal(
    isUserTokenAuthError({
      status: 403,
      errors: [{ reason: "quotaExceeded" }],
      message: "Quota exceeded",
    }),
    false
  );
  assert.equal(
    isUserTokenAuthError({
      status: 403,
      errors: [{ reason: "authError" }],
      message: "Request had insufficient authentication scopes.",
    }),
    true
  );
  assert.equal(
    isUserTokenAuthError({
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: "authError" }],
          },
        },
      },
      message: "Forbidden",
    }),
    true
  );
  assert.equal(
    isUserTokenAuthError({
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
      message: "Forbidden",
    }),
    true
  );
  assert.equal(
    isUserTokenAuthError({
      status: 403,
      errors: [{ reason: "rateLimitExceeded" }],
      message: "Forbidden",
    }),
    false
  );
});
