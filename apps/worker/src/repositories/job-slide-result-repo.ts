import type { PoolClient } from "pg";
import type { JobId, JobSlideResult } from "@translay/shared-contracts";

const UPSERT_COLUMNS_PER_ROW = 31;
const POSTGRES_MAX_PARAMETERS = 65535;
const MAX_SLIDE_RESULTS_PER_UPSERT = Math.floor(
  POSTGRES_MAX_PARAMETERS / UPSERT_COLUMNS_PER_ROW
);

export async function upsertJobSlideResults(
  client: PoolClient,
  jobId: JobId | string,
  slideResults: readonly JobSlideResult[]
): Promise<void> {
  if (slideResults.length === 0) {
    return;
  }

  for (
    let offset = 0;
    offset < slideResults.length;
    offset += MAX_SLIDE_RESULTS_PER_UPSERT
  ) {
    const chunk = slideResults.slice(offset, offset + MAX_SLIDE_RESULTS_PER_UPSERT);
    await upsertJobSlideResultsChunk(client, jobId, chunk);
  }
}

async function upsertJobSlideResultsChunk(
  client: PoolClient,
  jobId: JobId | string,
  slideResults: readonly JobSlideResult[]
): Promise<void> {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (const [index, slideResult] of slideResults.entries()) {
    const base = index * UPSERT_COLUMNS_PER_ROW;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20}, $${base + 21}, $${base + 22}, $${base + 23}, $${base + 24}, $${base + 25}, $${base + 26}, $${base + 27}, $${base + 28}, $${base + 29}, $${base + 30}, $${base + 31})`
    );
    values.push(
      jobId,
      slideResult.slide_index,
      slideResult.source_slide_object_id ?? null,
      slideResult.source_slide_fingerprint ?? null,
      slideResult.status,
      slideResult.failure_stage ?? null,
      slideResult.failure_reason_code ?? null,
      JSON.stringify(slideResult.warning_codes),
      slideResult.provisionally_billed,
      slideResult.final_billable,
      slideResult.refund_required,
      slideResult.refunded,
      slideResult.output_visible,
      slideResult.output_slide_object_id ?? null,
      slideResult.notes_present ?? false,
      slideResult.body_node_count ?? 0,
      slideResult.notes_node_count ?? 0,
      slideResult.content_translated ?? false,
      slideResult.notes_translated ?? false,
      slideResult.content_output_visible ?? false,
      slideResult.notes_output_visible ?? false,
      slideResult.notes_truncated ?? false,
      slideResult.body_translated_node_count ?? 0,
      slideResult.notes_translated_node_count ?? 0,
      slideResult.body_failed_node_count ?? 0,
      slideResult.notes_failed_node_count ?? 0,
      slideResult.body_written_node_count ?? 0,
      slideResult.notes_written_node_count ?? 0,
      slideResult.provisional_billed_units ?? 0,
      slideResult.final_billed_units ?? 0,
      slideResult.refunded_units ?? 0
    );
  }

  await client.query(
    `INSERT INTO job_slide_results (
       job_id,
       slide_index,
       source_slide_object_id,
       source_slide_fingerprint,
       status,
       failure_stage,
       failure_reason_code,
       warning_codes,
       provisionally_billed,
       final_billable,
       refund_required,
       refunded,
       output_visible,
       output_slide_object_id,
       notes_present,
       body_node_count,
       notes_node_count,
       content_translated,
       notes_translated,
       content_output_visible,
       notes_output_visible,
       notes_truncated,
       body_translated_node_count,
       notes_translated_node_count,
       body_failed_node_count,
       notes_failed_node_count,
       body_written_node_count,
       notes_written_node_count,
       provisional_billed_units,
       final_billed_units,
       refunded_units
     )
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (job_id, slide_index)
     DO UPDATE SET
       status = EXCLUDED.status,
      source_slide_object_id = EXCLUDED.source_slide_object_id,
      source_slide_fingerprint = EXCLUDED.source_slide_fingerprint,
       failure_stage = EXCLUDED.failure_stage,
       failure_reason_code = EXCLUDED.failure_reason_code,
       warning_codes = EXCLUDED.warning_codes,
       provisionally_billed = EXCLUDED.provisionally_billed,
       final_billable = EXCLUDED.final_billable,
       refund_required = EXCLUDED.refund_required,
       refunded = EXCLUDED.refunded,
       output_visible = EXCLUDED.output_visible,
      output_slide_object_id = EXCLUDED.output_slide_object_id,
      notes_present = EXCLUDED.notes_present,
      body_node_count = EXCLUDED.body_node_count,
      notes_node_count = EXCLUDED.notes_node_count,
      content_translated = EXCLUDED.content_translated,
      notes_translated = EXCLUDED.notes_translated,
      content_output_visible = EXCLUDED.content_output_visible,
      notes_output_visible = EXCLUDED.notes_output_visible,
      notes_truncated = EXCLUDED.notes_truncated,
      body_translated_node_count = EXCLUDED.body_translated_node_count,
      notes_translated_node_count = EXCLUDED.notes_translated_node_count,
      body_failed_node_count = EXCLUDED.body_failed_node_count,
      notes_failed_node_count = EXCLUDED.notes_failed_node_count,
      body_written_node_count = EXCLUDED.body_written_node_count,
      notes_written_node_count = EXCLUDED.notes_written_node_count,
      provisional_billed_units = EXCLUDED.provisional_billed_units,
      final_billed_units = EXCLUDED.final_billed_units,
      refunded_units = EXCLUDED.refunded_units,
       updated_at = NOW()`,
    values
  );
}

export const __MAX_SLIDE_RESULTS_PER_UPSERT_FOR_TESTS = MAX_SLIDE_RESULTS_PER_UPSERT;
