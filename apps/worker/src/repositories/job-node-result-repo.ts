import type { PoolClient } from "pg";
import type { JobId } from "@translay/shared-contracts";
import type { JobNodeExecutionResult } from "../pipelines/node-results";

const UPSERT_COLUMNS_PER_ROW = 11;
const POSTGRES_MAX_PARAMETERS = 65535;
const MAX_NODE_RESULTS_PER_UPSERT = Math.floor(
  POSTGRES_MAX_PARAMETERS / UPSERT_COLUMNS_PER_ROW
);

export async function upsertJobNodeResults(
  client: PoolClient,
  jobId: JobId | string,
  nodeResults: readonly JobNodeExecutionResult[]
): Promise<void> {
  if (nodeResults.length === 0) {
    return;
  }

  for (let offset = 0; offset < nodeResults.length; offset += MAX_NODE_RESULTS_PER_UPSERT) {
    const chunk = nodeResults.slice(offset, offset + MAX_NODE_RESULTS_PER_UPSERT);
    await upsertJobNodeResultsChunk(client, jobId, chunk);
  }
}

async function upsertJobNodeResultsChunk(
  client: PoolClient,
  jobId: JobId | string,
  nodeResults: readonly JobNodeExecutionResult[]
): Promise<void> {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (const [index, nodeResult] of nodeResults.entries()) {
    const base = index * UPSERT_COLUMNS_PER_ROW;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`
    );
    values.push(
      jobId,
      nodeResult.node_id,
      nodeResult.slide_index,
      nodeResult.source_slide_object_id,
      nodeResult.source_slide_fingerprint,
      nodeResult.node_kind,
      nodeResult.translation_status,
      nodeResult.materialization_status,
      nodeResult.write_status,
      nodeResult.output_visible,
      nodeResult.failure_reason_code ?? null
    );
  }

  await client.query(
    `INSERT INTO job_node_results (
       job_id,
       node_id,
       slide_index,
       source_slide_object_id,
       source_slide_fingerprint,
       node_kind,
       translation_status,
       materialization_status,
       write_status,
       output_visible,
       failure_reason_code
     )
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (job_id, node_id)
     DO UPDATE SET
       slide_index = EXCLUDED.slide_index,
       source_slide_object_id = EXCLUDED.source_slide_object_id,
       source_slide_fingerprint = EXCLUDED.source_slide_fingerprint,
       node_kind = EXCLUDED.node_kind,
       translation_status = EXCLUDED.translation_status,
       materialization_status = EXCLUDED.materialization_status,
       write_status = EXCLUDED.write_status,
       output_visible = EXCLUDED.output_visible,
       failure_reason_code = EXCLUDED.failure_reason_code,
       updated_at = NOW()`,
    values
  );
}
