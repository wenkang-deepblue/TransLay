import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { updateJobStatus } from "./job-repo";

test("worker terminal update records successful Drive cleanup and purges host OAuth token", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;

  await updateJobStatus(pool, "job-cleanup-ok", "completed", {
    driveCleanupStatus: "succeeded",
    driveCleanupLastErrorCode: null,
    incrementDriveCleanupAttempts: true,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_purged_at = NOW\(\)/);
  assert.match(calls[0]!.sql, /drive_cleanup_status = /);
  assert.match(calls[0]!.sql, /drive_cleanup_last_error_code = NULL/);
  assert.match(calls[0]!.sql, /drive_cleanup_completed_at = NOW\(\)/);
  assert.match(calls[0]!.sql, /drive_cleanup_attempts = drive_cleanup_attempts \+ 1/);
  assert.match(calls[0]!.sql, /drive_cleanup_last_attempt_at = NOW\(\)/);
  assert.deepEqual(calls[0]!.params?.slice(0, 3), [
    "job-cleanup-ok",
    "completed",
    "succeeded",
  ]);
});

test("worker terminal update records failed Drive cleanup without preserving host OAuth token", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;

  await updateJobStatus(pool, "job-cleanup-failed", "failed", {
    driveCleanupStatus: "failed",
    driveCleanupLastErrorCode: "host_oauth_token_expired",
    incrementDriveCleanupAttempts: true,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_purged_at = NOW\(\)/);
  assert.match(calls[0]!.sql, /drive_cleanup_status = /);
  assert.match(calls[0]!.sql, /drive_cleanup_last_error_code = /);
  assert.match(calls[0]!.sql, /drive_cleanup_completed_at = NULL/);
  assert.match(calls[0]!.sql, /drive_cleanup_attempts = drive_cleanup_attempts \+ 1/);
  assert.deepEqual(calls[0]!.params?.slice(0, 4), [
    "job-cleanup-failed",
    "failed",
    "failed",
    "host_oauth_token_expired",
  ]);
});
