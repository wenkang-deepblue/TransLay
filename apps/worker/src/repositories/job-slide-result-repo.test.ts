import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import type { JobSlideResult } from "@translay/shared-contracts";
import {
  __MAX_SLIDE_RESULTS_PER_UPSERT_FOR_TESTS,
  upsertJobSlideResults,
} from "./job-slide-result-repo";

function createSlideResult(slideIndex: number): JobSlideResult {
  return {
    slide_index: slideIndex,
    source_slide_object_id: `slide_${slideIndex}`,
    source_slide_fingerprint: `fingerprint_${slideIndex}`,
    status: "pending",
    warning_codes: [],
    provisionally_billed: false,
    final_billable: false,
    refund_required: false,
    refunded: false,
    output_visible: false,
    output_slide_object_id: undefined,
    body_node_count: 0,
    notes_node_count: 0,
    body_translated_node_count: 0,
    notes_translated_node_count: 0,
    body_failed_node_count: 0,
    notes_failed_node_count: 0,
    body_written_node_count: 0,
    notes_written_node_count: 0,
  };
}

test("upsertJobSlideResults chunks large batches under PostgreSQL parameter limit", async () => {
  const queryCalls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      return { rowCount: 1 };
    },
  } as unknown as PoolClient;

  const totalSlides = __MAX_SLIDE_RESULTS_PER_UPSERT_FOR_TESTS + 1;
  const slideResults = Array.from({ length: totalSlides }, (_, index) =>
    createSlideResult(index)
  );

  await upsertJobSlideResults(client, "job-1", slideResults);

  assert.equal(queryCalls.length, 2);
  assert.equal(
    queryCalls[0]?.values.length,
    __MAX_SLIDE_RESULTS_PER_UPSERT_FOR_TESTS * 31
  );
  assert.equal(queryCalls[1]?.values.length, 31);
  assert.match(queryCalls[0]?.sql ?? "", /INSERT INTO job_slide_results/);
  assert.match(queryCalls[1]?.sql ?? "", /INSERT INTO job_slide_results/);
});
