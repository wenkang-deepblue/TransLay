import type { Pool } from "pg";
import type { JobId } from "@translay/shared-contracts";
import type { LlmDebugCaptureEvent } from "../providers/llm-debug";

export async function insertLlmDebugOutput(
  pool: Pool,
  jobId: JobId | string,
  event: LlmDebugCaptureEvent
): Promise<void> {
  await pool.query(
    `INSERT INTO llm_debug_outputs (
       job_id,
       provider,
       model,
       stage,
       call_label,
       slide_index,
       node_ids,
       provider_request_id,
       capture_status,
       http_status,
       error_summary
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11
     )`,
    [
      jobId,
      event.provider,
      event.model,
      event.stage,
      event.call_label,
      event.slide_index ?? null,
      JSON.stringify(event.node_ids),
      event.provider_request_id ?? null,
      event.capture_status,
      event.http_status ?? null,
      event.error_summary ?? null,
    ]
  );
}

export async function purgeExpiredLlmDebugOutputs(
  pool: Pool,
  retentionHours: number
): Promise<void> {
  const safeRetentionHours = Number.isFinite(retentionHours) && retentionHours > 0
    ? Math.floor(retentionHours)
    : 72;

  await pool.query(
    `DELETE FROM llm_debug_outputs
      WHERE created_at < NOW() - make_interval(hours => $1::int)`,
    [safeRetentionHours]
  );
}
