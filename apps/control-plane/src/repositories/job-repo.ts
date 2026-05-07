import type { Pool, PoolClient } from "pg";
import type {
  HostType,
  DriveCleanupStatus,
  JobExecutionStage,
  JobStageStatus,
  JobWarning,
  OutputMode,
  RangeMode,
  JobStatus,
  SourceLanguageMode,
  UserId,
  JobId,
} from "@translay/shared-contracts";

export interface JobRow {
  id: JobId;
  user_id: string;
  host_type: HostType;
  source_doc_id: string;
  source_doc_name: string | null;
  target_doc_id: string | null;
  source_worker_permission_id: string | null;
  target_worker_permission_id: string | null;
  drive_cleanup_status: DriveCleanupStatus;
  drive_cleanup_attempts: number;
  drive_cleanup_last_error_code: string | null;
  drive_cleanup_last_attempt_at: Date | null;
  drive_cleanup_completed_at: Date | null;
  source_language_mode: string;
  source_language: string | null;
  target_language_input: string;
  target_language_code: string | null;
  output_mode: OutputMode;
  range_mode: RangeMode;
  range_expression: string | null;
  provider_route: string | null;
  status: JobStatus;
  provisionally_billed_units: number;
  gross_billed_slides: number;
  refunded_slides: number;
  net_billed_slides: number;
  total_units_billed: number;
  output_document_url: string | null;
  error_code: string | null;
  error_message: string | null;
  warnings: JobWarning[];
  cancel_requested_at: Date | null;
  current_stage: JobExecutionStage | null;
  stage_status: JobStageStatus | null;
  stage_cursor: Record<string, unknown>;
  stage_payload: Record<string, unknown>;
  stage_attempt: number;
  stage_lease_expires_at: Date | null;
  stage_last_heartbeat_at: Date | null;
  queued_task_name: string | null;
  started_at: Date;
  completed_at: Date | null;
}

// S7: Explicit column list instead of SELECT *
const JOB_COLUMNS = `id, user_id, host_type, source_doc_id, source_doc_name, target_doc_id,
  source_worker_permission_id, target_worker_permission_id,
  drive_cleanup_status, drive_cleanup_attempts, drive_cleanup_last_error_code,
  drive_cleanup_last_attempt_at, drive_cleanup_completed_at,
  source_language_mode, source_language, target_language_input, target_language_code,
  output_mode, range_mode, range_expression, provider_route, status,
  provisionally_billed_units, gross_billed_slides, refunded_slides, net_billed_slides, total_units_billed,
  output_document_url, error_code, error_message, warnings, cancel_requested_at,
  current_stage, stage_status, stage_cursor, stage_payload, stage_attempt,
  stage_lease_expires_at, stage_last_heartbeat_at, queued_task_name,
  started_at, completed_at`;
const GLOBAL_IN_FLIGHT_GATE_LOCK_ID = 314159;

export async function createJob(
  client: PoolClient,
  params: {
    userId: UserId;
    hostType: HostType;
    sourceDocId: string;
    targetDocId: string | null;
    sourceWorkerPermissionId: string | null;
    targetWorkerPermissionId: string | null;
    driveCleanupStatus: DriveCleanupStatus;
    sourceLangMode: SourceLanguageMode;
    targetLanguageInput: string;
    targetLanguageCode: string | null;
    outputMode: OutputMode;
    rangeMode: RangeMode;
    rangeExpression: string | null;
    hostOauthAccessTokenEnc: Buffer | null;
    hostOauthTokenExpiresAt: Date | null;
    hostOauthSource: "addon" | "sa_fallback";
  }
): Promise<JobId> {
  const result = await client.query(
    `INSERT INTO translation_jobs
       (user_id, host_type, source_doc_id, target_doc_id,
        source_worker_permission_id, target_worker_permission_id, drive_cleanup_status,
        source_language_mode, target_language_input, target_language_code,
       output_mode, range_mode, range_expression, host_oauth_access_token_enc,
       host_oauth_token_expires_at, host_oauth_source,
       status, current_stage, stage_status, stage_cursor, stage_payload, stage_attempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', 'extract', 'pending', '{}'::jsonb, '{}'::jsonb, 0)
     RETURNING id`,
    [
      params.userId,
      params.hostType,
      params.sourceDocId,
      params.targetDocId,
      params.sourceWorkerPermissionId,
      params.targetWorkerPermissionId,
      params.driveCleanupStatus,
      params.sourceLangMode,
      params.targetLanguageInput,
      params.targetLanguageCode,
      params.outputMode,
      params.rangeMode,
      params.rangeExpression,
      params.hostOauthAccessTokenEnc,
      params.hostOauthTokenExpiresAt,
      params.hostOauthSource,
    ]
  );
  return result.rows[0].id as JobId;
}

export async function getJobById(
  pool: Pool,
  jobId: JobId | string,
  userId: UserId
): Promise<JobRow | null> {
  const result = await pool.query(
    `SELECT ${JOB_COLUMNS} FROM translation_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  return normalizeJobRow(result.rows[0]);
}

export async function findUnresolvedDriveCleanupJobForSource(
  pool: Pool,
  params: {
    readonly userId: UserId;
    readonly sourceDocId: string;
  }
): Promise<JobRow | null> {
  const result = await pool.query(
    `SELECT ${JOB_COLUMNS}
       FROM translation_jobs
      WHERE user_id = $1
        AND source_doc_id = $2
        AND status IN ('completed', 'completed_with_warnings', 'failed', 'canceled', 'rolled_back')
        AND drive_cleanup_status IN ('pending', 'failed')
        AND (
          source_worker_permission_id IS NOT NULL
          OR target_worker_permission_id IS NOT NULL
        )
      ORDER BY started_at DESC
      LIMIT 1`,
    [params.userId, params.sourceDocId]
  );
  return normalizeJobRow(result.rows[0]);
}

export async function recordDriveCleanupRetryResult(
  pool: Pool,
  params: {
    readonly jobId: JobId | string;
    readonly userId: UserId;
    readonly status: Extract<DriveCleanupStatus, "not_required" | "succeeded" | "failed">;
    readonly errorCode: string | null;
  }
): Promise<JobRow | null> {
  const result = await pool.query(
    `WITH updated AS (
       UPDATE translation_jobs
          SET drive_cleanup_status = $2,
              drive_cleanup_attempts = drive_cleanup_attempts + 1,
              drive_cleanup_last_attempt_at = NOW(),
              drive_cleanup_last_error_code = CASE WHEN $2 IN ('not_required', 'succeeded') THEN NULL ELSE $3 END,
              drive_cleanup_completed_at = CASE WHEN $2 IN ('not_required', 'succeeded') THEN NOW() ELSE NULL END
        WHERE id = $1
          AND user_id = $4
          AND drive_cleanup_status IN ('pending', 'failed')
        RETURNING ${JOB_COLUMNS}
     )
     SELECT ${JOB_COLUMNS} FROM updated
     UNION ALL
     SELECT ${JOB_COLUMNS}
       FROM translation_jobs
      WHERE id = $1
        AND user_id = $4
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    [params.jobId, params.status, params.errorCode, params.userId]
  );
  return normalizeJobRow(result.rows[0]);
}

export async function hasRunningJob(
  pool: Pool | PoolClient,
  userId: UserId
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM translation_jobs
     WHERE user_id = $1 AND status IN ('pending', 'queued', 'extracting', 'translating', 'writing')
     LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

export async function countGlobalInFlightJobs(pool: Pool | PoolClient): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM translation_jobs
      WHERE status IN ('pending', 'queued', 'extracting', 'translating', 'writing')`
  );
  return toNumber(result.rows[0]?.n);
}

export async function acquireCreateJobAdmission(
  client: PoolClient,
  userId: UserId,
  maxGlobalInFlightJobs: number
): Promise<{
  readonly allowed: boolean;
  readonly blockedBy: "user" | "global" | null;
  readonly activeCount: number;
}> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [GLOBAL_IN_FLIGHT_GATE_LOCK_ID]);
  const userHasRunningJob = await hasRunningJob(client, userId);
  if (userHasRunningJob) {
    return {
      allowed: false,
      blockedBy: "user",
      activeCount: 0,
    };
  }
  const activeCount = await countGlobalInFlightJobs(client);
  return {
    allowed: activeCount < maxGlobalInFlightJobs,
    blockedBy: activeCount < maxGlobalInFlightJobs ? null : "global",
    activeCount,
  };
}

export async function updateJobStatus(
  pool: Pool,
  jobId: JobId,
  status: JobStatus,
  extra?: {
    errorCode?: string;
    errorMessage?: string;
    outputDocumentUrl?: string;
    provisionallyBilledUnits?: number;
    grossBilledSlides?: number;
    refundedSlides?: number;
    netBilledSlides?: number;
    totalUnitsBilled?: number;
    warnings?: readonly JobWarning[];
    currentStage?: JobExecutionStage | null;
    stageStatus?: JobStageStatus | null;
    stageCursor?: Record<string, unknown>;
    stagePayload?: Record<string, unknown>;
    stageAttempt?: number;
    stageLeaseExpiresAt?: Date | null;
    stageLastHeartbeatAt?: Date | null;
    queuedTaskName?: string | null;
    preserveHostOauthForCleanup?: boolean;
  }
): Promise<void> {
  const setClauses = ["status = $2"];
  const params: unknown[] = [jobId, status];
  let idx = 3;

  if (
    status === "completed" ||
    status === "completed_with_warnings" ||
    status === "failed" ||
    status === "canceled" ||
    status === "rolled_back"
  ) {
    setClauses.push("completed_at = NOW()");
    if (!extra?.preserveHostOauthForCleanup) {
      setClauses.push("host_oauth_access_token_enc = NULL");
      setClauses.push("host_oauth_token_expires_at = NULL");
      setClauses.push("host_oauth_source = 'sa_fallback'");
      setClauses.push("host_oauth_purged_at = NOW()");
    }
  }
  if (extra?.errorCode !== undefined) {
    setClauses.push(`error_code = $${idx}`);
    params.push(extra.errorCode);
    idx++;
  }
  if (extra?.errorMessage !== undefined) {
    setClauses.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }
  if (extra?.outputDocumentUrl !== undefined) {
    setClauses.push(`output_document_url = $${idx}`);
    params.push(extra.outputDocumentUrl);
    idx++;
  }
  if (extra?.provisionallyBilledUnits !== undefined) {
    setClauses.push(`provisionally_billed_units = $${idx}`);
    params.push(extra.provisionallyBilledUnits);
    idx++;
  }
  if (extra?.grossBilledSlides !== undefined) {
    setClauses.push(`gross_billed_slides = $${idx}`);
    params.push(extra.grossBilledSlides);
    idx++;
  }
  if (extra?.refundedSlides !== undefined) {
    setClauses.push(`refunded_slides = $${idx}`);
    params.push(extra.refundedSlides);
    idx++;
  }
  if (extra?.netBilledSlides !== undefined) {
    setClauses.push(`net_billed_slides = $${idx}`);
    params.push(extra.netBilledSlides);
    idx++;
  }
  if (extra?.totalUnitsBilled !== undefined) {
    setClauses.push(`total_units_billed = $${idx}`);
    params.push(extra.totalUnitsBilled);
    idx++;
  }
  if (extra?.warnings !== undefined) {
    setClauses.push(`warnings = $${idx}`);
    params.push(JSON.stringify(extra.warnings));
    idx++;
  }
  if (extra?.currentStage !== undefined) {
    setClauses.push(`current_stage = $${idx}`);
    params.push(extra.currentStage);
    idx++;
  }
  if (extra?.stageStatus !== undefined) {
    setClauses.push(`stage_status = $${idx}`);
    params.push(extra.stageStatus);
    idx++;
  }
  if (extra?.stageCursor !== undefined) {
    setClauses.push(`stage_cursor = $${idx}`);
    params.push(JSON.stringify(extra.stageCursor));
    idx++;
  }
  if (extra?.stagePayload !== undefined) {
    setClauses.push(`stage_payload = $${idx}`);
    params.push(JSON.stringify(extra.stagePayload));
    idx++;
  }
  if (extra?.stageAttempt !== undefined) {
    setClauses.push(`stage_attempt = $${idx}`);
    params.push(extra.stageAttempt);
    idx++;
  }
  if (extra?.stageLeaseExpiresAt !== undefined) {
    setClauses.push(`stage_lease_expires_at = $${idx}`);
    params.push(extra.stageLeaseExpiresAt);
    idx++;
  }
  if (extra?.stageLastHeartbeatAt !== undefined) {
    setClauses.push(`stage_last_heartbeat_at = $${idx}`);
    params.push(extra.stageLastHeartbeatAt);
    idx++;
  }
  if (extra?.queuedTaskName !== undefined) {
    setClauses.push(`queued_task_name = $${idx}`);
    params.push(extra.queuedTaskName);
    idx++;
  }

  await pool.query(
    `UPDATE translation_jobs SET ${setClauses.join(", ")} WHERE id = $1`,
    params
  );
}

export async function requestJobCancel(
  pool: Pool,
  jobId: JobId | string,
  userId: UserId
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE translation_jobs
     SET cancel_requested_at = COALESCE(cancel_requested_at, NOW())
     WHERE id = $1
       AND user_id = $2
       AND status IN ('extracting', 'translating', 'writing')`,
    [jobId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasCompletedEquivalentJob(
  pool: Pool,
  params: {
    userId: UserId;
    hostType: HostType;
    sourceDocId: string;
    targetLanguageInput: string;
    outputMode: OutputMode;
    rangeMode: RangeMode;
    rangeExpression: string | null;
  }
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM translation_jobs
     WHERE user_id = $1
       AND host_type = $2
       AND source_doc_id = $3
       AND lower(target_language_input) = lower($4)
       AND output_mode = $5
       AND range_mode = $6
       AND COALESCE(range_expression, '') = COALESCE($7, '')
       AND status IN ('completed', 'completed_with_warnings')
     LIMIT 1`,
    [
      params.userId,
      params.hostType,
      params.sourceDocId,
      params.targetLanguageInput,
      params.outputMode,
      params.rangeMode,
      params.rangeExpression,
    ]
  );
  return result.rows.length > 0;
}

export async function sweepExpiredHostOauthTokens(
  pool: Pool,
  options: {
    readonly gracePeriodMinutes?: number;
    readonly limit?: number;
  } = {}
): Promise<number> {
  const gracePeriodMinutes = Math.max(0, options.gracePeriodMinutes ?? 60);
  const limit = Math.max(1, options.limit ?? 500);
  const result = await pool.query(
    `WITH expired_jobs AS (
       SELECT id
         FROM translation_jobs
        WHERE host_oauth_access_token_enc IS NOT NULL
          AND host_oauth_token_expires_at IS NOT NULL
          AND host_oauth_token_expires_at < NOW() - make_interval(mins => $1::int)
        ORDER BY host_oauth_token_expires_at ASC
        LIMIT $2
     )
     UPDATE translation_jobs
        SET host_oauth_access_token_enc = NULL,
            host_oauth_token_expires_at = NULL,
            host_oauth_source = 'sa_fallback',
            host_oauth_purged_at = NOW()
      WHERE id IN (SELECT id FROM expired_jobs)
      RETURNING id`,
    [gracePeriodMinutes, limit]
  );
  return result.rowCount ?? 0;
}

function normalizeJobRow(row: JobRow | undefined): JobRow | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    provisionally_billed_units: toNumber(row.provisionally_billed_units),
    gross_billed_slides: toNumber(row.gross_billed_slides),
    refunded_slides: toNumber(row.refunded_slides),
    net_billed_slides: toNumber(row.net_billed_slides),
    total_units_billed: toNumber(row.total_units_billed),
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    drive_cleanup_attempts: toNumber(row.drive_cleanup_attempts),
    stage_cursor: toJsonObject(row.stage_cursor),
    stage_payload: toJsonObject(row.stage_payload),
    stage_attempt: toNumber(row.stage_attempt),
  };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}
