import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  DriveCleanupAuthError,
  __resetDriveAuthHooksForTests,
  __setDriveAuthHooksForTests,
  getDriveClientForJob,
} from "./auth";

function createPoolMock(
  row: {
    user_id: string;
    host_oauth_access_token_enc: Buffer | string | null;
    host_oauth_token_expires_at: Date | string | null;
    host_oauth_source: "addon" | "sa_fallback";
  } | null
): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM translation_jobs")) {
        return { rows: row ? [row] : [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  } as Pool;
}

test("getDriveClientForJob uses decrypted host OAuth token for Drive cleanup", async () => {
  const auth = { kind: "drive-user-auth" };
  const drive = { kind: "drive-client" };

  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async (ciphertext) => {
      assert.equal(Buffer.from(ciphertext).toString("utf8"), "token");
      return "decrypted-drive-token";
    },
    buildUserDriveClient: (accessToken) => {
      assert.equal(accessToken, "decrypted-drive-token");
      return {
        auth: auth as never,
        drive: drive as never,
      };
    },
  });

  try {
    const context = await getDriveClientForJob(
      "job-drive-cleanup",
      createPoolMock({
        user_id: "user-1",
        host_oauth_access_token_enc: "\\x746f6b656e",
        host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
        host_oauth_source: "addon",
      })
    );

    assert.equal(context.source, "user");
    assert.equal(context.jobId, "job-drive-cleanup");
    assert.equal(context.userId, "user-1");
    assert.equal(context.auth, auth);
    assert.equal(context.drive, drive);
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob rejects expired host OAuth tokens before cleanup", async () => {
  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async () => {
      throw new Error("decrypt should not run for expired tokens");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-expired-token",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: Buffer.from("ciphertext"),
            host_oauth_token_expires_at: "2026-05-06T09:59:59.000Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_token_expired");
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob requires the same minimum token TTL buffer as Slides", async () => {
  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async () => {
      throw new Error("decrypt should not run when token TTL is too short");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-near-expired-token",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: Buffer.from("ciphertext"),
            host_oauth_token_expires_at: "2026-05-06T10:01:59.999Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_token_expired");
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob distinguishes missing job rows from missing tokens", async () => {
  await assert.rejects(
    () => getDriveClientForJob("job-missing", createPoolMock(null)),
    (error) => {
      assert.equal(error instanceof DriveCleanupAuthError, true);
      assert.equal((error as DriveCleanupAuthError).code, "job_not_found");
      assert.doesNotMatch((error as Error).message, /job-missing/);
      return true;
    }
  );
});

test("getDriveClientForJob rejects empty encrypted tokens without decrypting", async () => {
  __setDriveAuthHooksForTests({
    decryptToken: async () => {
      throw new Error("decrypt should not run for empty tokens");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-empty-token",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: Buffer.alloc(0),
            host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_token_missing");
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob rejects invalid bytea hex tokens without decrypting", async () => {
  __setDriveAuthHooksForTests({
    decryptToken: async () => {
      throw new Error("decrypt should not run for malformed bytea tokens");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-malformed-token",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: "\\xnot-hex",
            host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_token_missing");
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob reset restores the default google Drive client builder", async () => {
  __setDriveAuthHooksForTests({
    buildUserDriveClient: () => {
      throw new Error("overridden builder should be reset");
    },
  });
  __resetDriveAuthHooksForTests();
  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async () => "default-builder-token",
  });

  try {
    const context = await getDriveClientForJob(
      "job-default-builder",
      createPoolMock({
        user_id: "user-1",
        host_oauth_access_token_enc: Buffer.from("ciphertext"),
        host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
        host_oauth_source: "addon",
      })
    );

    assert.equal(context.source, "user");
    assert.equal(typeof context.drive.permissions.delete, "function");
    assert.deepEqual(context.auth.credentials, {
      access_token: "default-builder-token",
    });
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob returns a safe cleanup auth error when Drive client build fails", async () => {
  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async () => "decrypted-drive-token",
    buildUserDriveClient: () => {
      throw new Error("google client unavailable for decrypted-drive-token");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-client-build-failure",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: Buffer.from("ciphertext"),
            host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_client_build_failed");
        assert.doesNotMatch((error as Error).message, /decrypted-drive-token/);
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});

test("getDriveClientForJob returns a safe cleanup auth error when decrypt fails", async () => {
  __setDriveAuthHooksForTests({
    nowMs: () => Date.parse("2026-05-06T10:00:00.000Z"),
    decryptToken: async () => {
      throw new Error("kms unavailable");
    },
  });

  try {
    await assert.rejects(
      () =>
        getDriveClientForJob(
          "job-decrypt-failure",
          createPoolMock({
            user_id: "user-1",
            host_oauth_access_token_enc: Buffer.from("ciphertext"),
            host_oauth_token_expires_at: "2026-05-06T10:05:00.000Z",
            host_oauth_source: "addon",
          })
        ),
      (error) => {
        assert.equal(error instanceof DriveCleanupAuthError, true);
        assert.equal((error as DriveCleanupAuthError).code, "host_oauth_decrypt_failed");
        assert.doesNotMatch((error as Error).message, /ciphertext|decrypted-drive-token/);
        return true;
      }
    );
  } finally {
    __resetDriveAuthHooksForTests();
  }
});
