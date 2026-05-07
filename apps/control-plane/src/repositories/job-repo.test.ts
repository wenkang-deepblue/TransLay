import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { JobId, UserId } from "@translay/shared-contracts";
import {
  acquireCreateJobAdmission,
  countGlobalInFlightJobs,
  createJob,
  findUnresolvedDriveCleanupJobForSource,
  recordDriveCleanupRetryResult,
  sweepExpiredHostOauthTokens,
  updateJobStatus,
} from "./job-repo";

test("createJob persists worker permission ids and pending cleanup status", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: "job-1" }], rowCount: 1 };
    },
  } as unknown as Parameters<typeof createJob>[0];

  const jobId = await createJob(client, {
    userId: "user-1" as UserId,
    hostType: "slides",
    sourceDocId: "source-doc",
    targetDocId: "target-doc",
    sourceWorkerPermissionId: "source-permission",
    targetWorkerPermissionId: "target-permission",
    driveCleanupStatus: "pending",
    sourceLangMode: "auto",
    targetLanguageInput: "French",
    targetLanguageCode: "FR",
    outputMode: "create_new_file",
    rangeMode: "custom",
    rangeExpression: "1",
    hostOauthAccessTokenEnc: Buffer.from("ciphertext"),
    hostOauthTokenExpiresAt: new Date("2026-05-06T10:00:00.000Z"),
    hostOauthSource: "addon",
  });

  assert.equal(jobId, "job-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /source_worker_permission_id/);
  assert.match(calls[0]!.sql, /target_worker_permission_id/);
  assert.match(calls[0]!.sql, /drive_cleanup_status/);
  assert.deepEqual(calls[0]!.params?.slice(4, 7), [
    "source-permission",
    "target-permission",
    "pending",
  ]);
});

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
  assert.doesNotMatch(calls[0]!.sql, /source_worker_permission_id = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /target_worker_permission_id = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /drive_cleanup_status = 'not_required'/);
});

test("updateJobStatus can preserve host OAuth fields for pending cleanup", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  await updateJobStatus(pool, "job-1" as JobId, "failed", {
    errorCode: "JOB_INTERNAL_ERROR",
    preserveHostOauthForCleanup: true,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /completed_at = NOW\(\)/);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_access_token_enc = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_token_expires_at = NULL/);
  assert.doesNotMatch(calls[0]!.sql, /host_oauth_purged_at = NOW\(\)/);
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

test("findUnresolvedDriveCleanupJobForSource uses translation_jobs cleanup truth", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return {
        rows: [{
          id: "job-1",
          user_id: "user-1",
          host_type: "slides",
          source_doc_id: "source-doc",
          source_doc_name: null,
          target_doc_id: null,
          source_worker_permission_id: "source-permission",
          target_worker_permission_id: null,
          drive_cleanup_status: "pending",
          drive_cleanup_attempts: "0",
          drive_cleanup_last_error_code: null,
          drive_cleanup_last_attempt_at: null,
          drive_cleanup_completed_at: null,
          source_language_mode: "auto",
          source_language: null,
          target_language_input: "French",
          target_language_code: "FR",
          output_mode: "append_in_file",
          range_mode: "custom",
          range_expression: "1",
          provider_route: null,
          status: "failed",
          provisionally_billed_units: "0",
          gross_billed_slides: "0",
          refunded_slides: "0",
          net_billed_slides: "0",
          total_units_billed: "0",
          output_document_url: null,
          error_code: "JOB_INTERNAL_ERROR",
          error_message: "Failed to enqueue job.",
          warnings: [],
          cancel_requested_at: null,
          current_stage: "extract",
          stage_status: "pending",
          stage_cursor: {},
          stage_payload: {},
          stage_attempt: "0",
          stage_lease_expires_at: null,
          stage_last_heartbeat_at: null,
          queued_task_name: null,
          started_at: new Date("2026-05-06T10:00:00.000Z"),
          completed_at: new Date("2026-05-06T10:01:00.000Z"),
        }],
        rowCount: 1,
      };
    },
  } as unknown as Pool;

  const job = await findUnresolvedDriveCleanupJobForSource(pool, {
    userId: "user-1" as UserId,
    sourceDocId: "source-doc",
  });

  assert.equal(job?.id, "job-1");
  assert.equal(job?.drive_cleanup_attempts, 0);
  assert.match(calls[0]!.sql, /drive_cleanup_status IN \('pending', 'failed'\)/);
  assert.match(calls[0]!.sql, /source_worker_permission_id IS NOT NULL/);
  assert.deepEqual(calls[0]!.params, ["user-1", "source-doc"]);
});

test("recordDriveCleanupRetryResult is scoped by job id and user id", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await recordDriveCleanupRetryResult(pool, {
    jobId: "job-1" as JobId,
    userId: "user-1" as UserId,
    status: "failed",
    errorCode: "drive_cleanup_forbidden",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /WHERE id = \$1\s+AND user_id = \$4/);
  assert.match(calls[0]!.sql, /drive_cleanup_status IN \('pending', 'failed'\)/);
  assert.deepEqual(calls[0]!.params, [
    "job-1",
    "failed",
    "drive_cleanup_forbidden",
    "user-1",
  ]);
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
