import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { UserId } from "@translay/shared-contracts";
import { listJobSlideResults } from "./job-slide-result-repo";

test("listJobSlideResults normalizes boolean columns defensively", async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          slide_index: 0,
          status: "committed",
          failure_stage: null,
          failure_reason_code: null,
          warning_codes: null,
          provisionally_billed: "t",
          final_billable: "f",
          refund_required: "false",
          refunded: 1,
          output_visible: 0,
        },
      ],
    }),
  } as unknown as Pool;

  const results = await listJobSlideResults(
    pool,
    "job-1",
    "user-1" as UserId
  );

  assert.deepEqual(results, [
    {
      slide_index: 0,
      status: "committed",
      failure_stage: null,
      failure_reason_code: null,
      warning_codes: [],
      provisionally_billed: true,
      final_billable: false,
      refund_required: false,
      refunded: true,
      output_visible: false,
    },
  ]);
});
