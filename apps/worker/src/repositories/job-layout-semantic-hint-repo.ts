import type { Pool, PoolClient } from "pg";
import type { JobId } from "@translay/shared-contracts";
import type { SlideLayoutSemanticHint } from "../adapters/slides/types";

export interface PersistedJobLayoutSemanticHint extends SlideLayoutSemanticHint {
  readonly slide_index: number;
}

export async function replaceJobLayoutSemanticHintsForSlide(
  poolOrClient: Pool | PoolClient,
  jobId: JobId | string,
  slideIndex: number,
  hints: readonly SlideLayoutSemanticHint[]
): Promise<void> {
  if (!isPoolClient(poolOrClient)) {
    const client = await poolOrClient.connect();
    try {
      await client.query("BEGIN");
      await replaceJobLayoutSemanticHintsForSlide(client, jobId, slideIndex, hints);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  await poolOrClient.query(
    `DELETE FROM job_layout_semantic_hints
     WHERE job_id = $1
       AND slide_index = $2`,
    [jobId, slideIndex]
  );

  if (hints.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = hints.map((hint, index) => {
    const offset = index * 8;
    values.push(
      jobId,
      slideIndex,
      hint.node_id,
      hint.visual_role,
      hint.cluster_id,
      hint.line_policy,
      hint.scale_sync,
      hint.confidence
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
  });

  await poolOrClient.query(
    `INSERT INTO job_layout_semantic_hints (
       job_id,
       slide_index,
       node_id,
       visual_role,
       cluster_id,
       line_policy,
       scale_sync,
       confidence
     ) VALUES ${placeholders.join(", ")}`,
    values
  );
}

function isPoolClient(poolOrClient: Pool | PoolClient): poolOrClient is PoolClient {
  return typeof (poolOrClient as PoolClient).release === "function";
}

export async function listJobLayoutSemanticHints(
  poolOrClient: Pool | PoolClient,
  jobId: JobId | string
): Promise<PersistedJobLayoutSemanticHint[]> {
  const result = await poolOrClient.query(
    `SELECT slide_index, node_id, visual_role, cluster_id, line_policy, scale_sync, confidence
     FROM job_layout_semantic_hints
     WHERE job_id = $1
     ORDER BY slide_index ASC, node_id ASC`,
    [jobId]
  );

  return result.rows.map((row) => ({
    slide_index: toNumber(row.slide_index),
    node_id: String(row.node_id),
    visual_role: row.visual_role as SlideLayoutSemanticHint["visual_role"],
    cluster_id: String(row.cluster_id),
    line_policy: row.line_policy as SlideLayoutSemanticHint["line_policy"],
    scale_sync: row.scale_sync as SlideLayoutSemanticHint["scale_sync"],
    confidence: toNumber(row.confidence),
  }));
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
