import type { Pool, PoolClient } from "pg";
import type {
  HostType,
  OutputMode,
  RangeMode,
  JobStatus,
  UserId,
  JobId,
} from "@translay/shared-contracts";

export interface JobRow {
  id: JobId;
  user_id: string;
  host_type: HostType;
  source_doc_id: string;
  source_doc_name: string;
  source_language_mode: string;
  source_language: string | null;
  target_language_input: string;
  target_language_code: string | null;
  output_mode: OutputMode;
  range_mode: RangeMode;
  range_expression: string | null;
  provider_route: string | null;
  status: JobStatus;
  total_units_billed: number;
  output_document_url: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
}

// S7: Explicit column list instead of SELECT *
const JOB_COLUMNS = `id, user_id, host_type, source_doc_id, source_doc_name,
  source_language_mode, source_language, target_language_input, target_language_code,
  output_mode, range_mode, range_expression, provider_route, status, total_units_billed,
  output_document_url, error_code, error_message, started_at, completed_at`;

export async function createJob(
  client: PoolClient,
  params: {
    userId: UserId;
    hostType: HostType;
    sourceDocId: string;
    sourceDocName: string;
    sourceLangMode: "auto";
    targetLanguageInput: string;
    targetLanguageCode: string | null;
    outputMode: OutputMode;
    rangeMode: RangeMode;
    rangeExpression: string | null;
  }
): Promise<JobId> {
  const result = await client.query(
    `INSERT INTO translation_jobs
       (user_id, host_type, source_doc_id, source_doc_name,
        source_language_mode, target_language_input, target_language_code,
        output_mode, range_mode, range_expression, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     RETURNING id`,
    [
      params.userId,
      params.hostType,
      params.sourceDocId,
      params.sourceDocName,
      params.sourceLangMode,
      params.targetLanguageInput,
      params.targetLanguageCode,
      params.outputMode,
      params.rangeMode,
      params.rangeExpression,
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
  return result.rows[0] ?? null;
}

export async function hasRunningJob(
  pool: Pool,
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

export async function updateJobStatus(
  pool: Pool,
  jobId: JobId,
  status: JobStatus,
  extra?: { errorCode?: string; errorMessage?: string; outputDocumentUrl?: string }
): Promise<void> {
  const setClauses = ["status = $2"];
  const params: unknown[] = [jobId, status];
  let idx = 3;

  if (status === "completed" || status === "failed") {
    setClauses.push("completed_at = NOW()");
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

  await pool.query(
    `UPDATE translation_jobs SET ${setClauses.join(", ")} WHERE id = $1`,
    params
  );
}
