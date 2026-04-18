import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { JobId, UserId } from "@translay/shared-contracts";
import {
  acquireCreateJobAdmission,
  countGlobalInFlightJobs,
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

test("updateJobStatus preserves host OAuth fields on non-terminal statuses", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  await updateJobStatus(pool, "job-queued" as JobId, "queued", {
    currentStage: "extract",
    stageStatus: "queued",
  });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_purged_at = NOW\(\)/);
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

test("countGlobalInFlightJobs returns the integer count of active jobs", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ n: "17" }], rowCount: 1 };
    },
  } as unknown as Pool;

  const count = await countGlobalInFlightJobs(pool);

  assert.equal(count, 17);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /COUNT\(\*\)::int AS n/);
  assert.match(calls[0]!.sql, /status IN \('pending', 'queued', 'extracting', 'translating', 'writing'\)/);
});

test("acquireCreateJobAdmission takes an advisory lock before evaluating capacity", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT 1 FROM translation_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("COUNT(*)::int AS n")) {
        return { rows: [{ n: "49" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Parameters<typeof acquireCreateJobAdmission>[0];

  const result = await acquireCreateJobAdmission(client, "user-1" as UserId, 50);

  assert.deepEqual(result, { allowed: true, blockedBy: null, activeCount: 49 });
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /pg_advisory_xact_lock/);
  assert.match(calls[1]!.sql, /SELECT 1 FROM translation_jobs/);
  assert.match(calls[2]!.sql, /COUNT\(\*\)::int AS n/);
});

test("acquireCreateJobAdmission blocks when the same user already has a running job", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 FROM translation_jobs")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)::int AS n")) {
        throw new Error("should not count global jobs when same-user admission already failed");
      }
      throw new Error(`Unexpected client query: ${sql}`);
    },
  } as unknown as Parameters<typeof acquireCreateJobAdmission>[0];

  const result = await acquireCreateJobAdmission(client, "user-1" as UserId, 50);

  assert.deepEqual(result, { allowed: false, blockedBy: "user", activeCount: 0 });
});
