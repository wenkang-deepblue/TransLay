import type { Pool, PoolClient } from "pg";
import type {
  HostType,
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
  started_at: Date;
  completed_at: Date | null;
}

const JOB_COLUMNS = `id, user_id, host_type, source_doc_id, source_doc_name, target_doc_id,
  source_language_mode, source_language, target_language_input, target_language_code,
  output_mode, range_mode, range_expression, provider_route, status,
  provisionally_billed_units, gross_billed_slides, refunded_slides, net_billed_slides, total_units_billed,
  output_document_url, error_code, error_message, warnings, cancel_requested_at, started_at, completed_at`;

export async function getJobById(pool: Pool, jobId: string): Promise<JobRow | null> {
  // Internal-only worker lookup: the caller is the trusted Cloud Tasks pipeline,
  // so ownership was already enforced when the control-plane created the task.
  const result = await pool.query(
    `SELECT ${JOB_COLUMNS} FROM translation_jobs WHERE id = $1`,
    [jobId]
  );
  return result.rows[0] ?? null;
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
  }
): Promise<void> {
  const setClauses = ["status = $2"];
  const params: unknown[] = [jobId, status];
  let idx = 3;

  if (
    status === "completed" ||
    status === "completed_with_warnings" ||
    status === "failed" ||
    status === "canceled"
  ) {
    setClauses.push("completed_at = NOW()");
  }
  if (status === "extracting") {
    setClauses.push("started_at = NOW()");
  }
  if (extra?.errorCode) {
    setClauses.push(`error_code = $${idx}`);
    params.push(extra.errorCode);
    idx++;
  }
  if (extra?.errorMessage) {
    setClauses.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }
  if (extra?.outputDocumentUrl) {
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
