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
  JobId,
  UserId,
} from "@translay/shared-contracts";

export interface JobRow {
  id: JobId;
  user_id: UserId;
  host_type: HostType;
  source_doc_id: string;
  source_doc_name: string;
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
  provider_route: Record<string, unknown>;
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

export async function getJobById(pool: Pool, jobId: string): Promise<JobRow | null> {
  // Internal worker lookup after control-plane ownership checks have already succeeded.
  const result = await pool.query(
    `SELECT ${JOB_COLUMNS} FROM translation_jobs WHERE id = $1`,
    [jobId]
  );
  return normalizeJobRow(result.rows[0]);
}

export async function updateJobStatus(
  poolOrClient: Pool | PoolClient,
  jobId: string,
  status: JobStatus,
  extra?: {
    errorCode?: string;
    errorMessage?: string;
    outputDocumentUrl?: string;
    providerRoute?: Record<string, unknown>;
    provisionallyBilledUnits?: number;
    grossBilledSlides?: number;
    refundedSlides?: number;
    netBilledSlides?: number;
    totalUnitsBilled?: number;
    sourceLang?: string;
    targetLangCode?: string;
    warnings?: readonly JobWarning[];
    currentStage?: JobExecutionStage | null;
    stageStatus?: JobStageStatus | null;
    stageCursor?: Record<string, unknown>;
    stagePayload?: Record<string, unknown>;
    stageAttempt?: number;
    stageLeaseExpiresAt?: Date | null;
    stageLastHeartbeatAt?: Date | null;
    queuedTaskName?: string | null;
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
    setClauses.push("host_oauth_access_token_enc = NULL");
    setClauses.push("host_oauth_token_expires_at = NULL");
    setClauses.push("host_oauth_source = 'sa_fallback'");
    setClauses.push("host_oauth_purged_at = NOW()");
  }
  if (status === "extracting") {
    setClauses.push("started_at = NOW()");
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
  if (extra?.providerRoute) {
    setClauses.push(`provider_route = $${idx}`);
    params.push(JSON.stringify(extra.providerRoute));
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
  if (extra?.sourceLang) {
    setClauses.push(`source_language = $${idx}`);
    params.push(extra.sourceLang);
    idx++;
  }
  if (extra?.targetLangCode) {
    setClauses.push(`target_language_code = $${idx}`);
    params.push(extra.targetLangCode);
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

  await poolOrClient.query(
    `UPDATE translation_jobs SET ${setClauses.join(", ")} WHERE id = $1`,
    params
  );
}

export async function isCancelRequested(
  poolOrClient: Pool | PoolClient,
  jobId: string
): Promise<boolean> {
  const result = await poolOrClient.query(
    `SELECT cancel_requested_at
     FROM translation_jobs
     WHERE id = $1`,
    [jobId]
  );
  return Boolean(result.rows[0]?.cancel_requested_at);
}

export async function claimJobStageLease(
  poolOrClient: Pool | PoolClient,
  jobId: string,
  stage: JobExecutionStage,
  stageAttempt: number,
  leaseSeconds: number
): Promise<
  | { readonly status: "claimed" }
  | { readonly status: "busy"; readonly leaseExpiresAt: Date | null }
  | { readonly status: "stale" }
> {
  const result = await poolOrClient.query(
    `UPDATE translation_jobs
     SET stage_status = 'running',
         stage_last_heartbeat_at = NOW(),
         stage_lease_expires_at = NOW() + make_interval(secs => $4::int),
         queued_task_name = NULL
     WHERE id = $1
       AND current_stage = $2
       AND stage_attempt = $3
       AND (
         stage_status IS DISTINCT FROM 'running'
         OR stage_lease_expires_at IS NULL
         OR stage_lease_expires_at <= NOW()
       )
     RETURNING id`,
    [jobId, stage, stageAttempt, Math.max(leaseSeconds, 30)]
  );

  if ((result.rowCount ?? 0) > 0) {
    return { status: "claimed" };
  }

  const state = await poolOrClient.query(
    `SELECT current_stage, stage_attempt, stage_status, stage_lease_expires_at
     FROM translation_jobs
     WHERE id = $1`,
    [jobId]
  );
  const row = state.rows[0];
  if (!row) {
    return { status: "stale" };
  }

  if (row.current_stage !== stage || toNumber(row.stage_attempt) !== stageAttempt) {
    return { status: "stale" };
  }

  return {
    status: "busy",
    leaseExpiresAt:
      row.stage_lease_expires_at instanceof Date
        ? row.stage_lease_expires_at
        : row.stage_lease_expires_at
          ? new Date(row.stage_lease_expires_at)
          : null,
  };
}

export async function heartbeatJobStage(
  poolOrClient: Pool | PoolClient,
  jobId: string,
  stage: JobExecutionStage,
  stageAttempt: number,
  leaseSeconds: number
): Promise<void> {
  await poolOrClient.query(
    `UPDATE translation_jobs
     SET stage_last_heartbeat_at = NOW(),
         stage_lease_expires_at = NOW() + make_interval(secs => $4::int)
     WHERE id = $1
       AND current_stage = $2
       AND stage_attempt = $3`,
    [jobId, stage, stageAttempt, Math.max(leaseSeconds, 30)]
  );
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
