import type { Pool } from "pg";
import type { JobId, JobSlideResult, UserId } from "@translay/shared-contracts";

export async function listJobSlideResults(
  pool: Pool,
  jobId: JobId | string,
  userId: UserId
): Promise<JobSlideResult[]> {
  const result = await pool.query<JobSlideResult>(
    `SELECT
       jsr.slide_index,
       jsr.source_slide_object_id,
       jsr.source_slide_fingerprint,
       jsr.status,
       jsr.failure_stage,
       jsr.failure_reason_code,
       jsr.warning_codes,
       jsr.provisionally_billed,
       jsr.final_billable,
       jsr.refund_required,
       jsr.refunded,
       jsr.output_visible,
       jsr.output_slide_object_id,
       jsr.notes_present,
       jsr.body_node_count,
       jsr.notes_node_count,
       jsr.content_translated,
       jsr.notes_translated,
       jsr.content_output_visible,
       jsr.notes_output_visible,
       jsr.notes_truncated,
       jsr.body_translated_node_count,
       jsr.notes_translated_node_count,
       jsr.body_failed_node_count,
       jsr.notes_failed_node_count,
       jsr.body_written_node_count,
       jsr.notes_written_node_count,
       jsr.provisional_billed_units,
       jsr.final_billed_units,
       jsr.refunded_units
     FROM job_slide_results jsr
     INNER JOIN translation_jobs tj
       ON tj.id = jsr.job_id
     WHERE jsr.job_id = $1
       AND tj.user_id = $2
     ORDER BY jsr.slide_index ASC`,
    [jobId, userId]
  );

  return result.rows.map((row) => ({
    ...row,
    warning_codes: Array.isArray(row.warning_codes) ? row.warning_codes : [],
    provisionally_billed: toBoolean(row.provisionally_billed),
    final_billable: toBoolean(row.final_billable),
    refund_required: toBoolean(row.refund_required),
    refunded: toBoolean(row.refunded),
    output_visible: toBoolean(row.output_visible),
    output_slide_object_id:
      typeof row.output_slide_object_id === "string" ? row.output_slide_object_id : undefined,
    notes_present: toBoolean(row.notes_present),
    source_slide_object_id:
      typeof row.source_slide_object_id === "string" ? row.source_slide_object_id : undefined,
    source_slide_fingerprint:
      typeof row.source_slide_fingerprint === "string" ? row.source_slide_fingerprint : undefined,
    body_node_count: toNumber(row.body_node_count),
    notes_node_count: toNumber(row.notes_node_count),
    content_translated: toBoolean(row.content_translated),
    notes_translated: toBoolean(row.notes_translated),
    content_output_visible: toBoolean(row.content_output_visible),
    notes_output_visible: toBoolean(row.notes_output_visible),
    notes_truncated: toBoolean(row.notes_truncated),
    body_translated_node_count: toNumber(row.body_translated_node_count),
    notes_translated_node_count: toNumber(row.notes_translated_node_count),
    body_failed_node_count: toNumber(row.body_failed_node_count),
    notes_failed_node_count: toNumber(row.notes_failed_node_count),
    body_written_node_count: toNumber(row.body_written_node_count),
    notes_written_node_count: toNumber(row.notes_written_node_count),
    provisional_billed_units: toNumber(row.provisional_billed_units),
    final_billed_units: toNumber(row.final_billed_units),
    refunded_units: toNumber(row.refunded_units),
  }));
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value.toLowerCase() === "t";
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return false;
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
