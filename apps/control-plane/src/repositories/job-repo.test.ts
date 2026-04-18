import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { JobId } from "@translay/shared-contracts";
import {
  sweepExpiredHostOauthTokens,
  updateJobStatus,
} from "./job-repo";

test("updateJobStatus clears host OAuth fields on terminal statuses", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  await updateJobStatus(pool, "job-1" as JobId, "completed");

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_source = 'sa_fallback'/);
  assert.match(calls[0]!.sql, /host_oauth_purged_at = NOW\(\)/);
});

test("sweepExpiredHostOauthTokens clears stale encrypted tokens in bounded batches", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: "job-1" }, { id: "job-2" }], rowCount: 2 };
    },
  } as unknown as Pool;

  const purged = await sweepExpiredHostOauthTokens(pool, {
    gracePeriodMinutes: 90,
    limit: 25,
  });

  assert.equal(purged, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /WITH expired_jobs AS/);
  assert.match(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.match(calls[0]!.sql, /host_oauth_source = 'sa_fallback'/);
  assert.deepEqual(calls[0]!.params, [90, 25]);
});
