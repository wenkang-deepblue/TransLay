import test from "node:test";
import assert from "node:assert/strict";
import type { JobId, JobWarning, UserId } from "@translay/shared-contracts";
import { __buildJobStatusResponseForTests } from "./handler";

function createBaseJob() {
  return {
    id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" as JobId,
    user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId,
    host_type: "slides" as const,
    source_doc_id: "source-doc",
    source_doc_name: "Quarterly deck",
    target_doc_id: "target-doc",
    source_language_mode: "auto",
    source_language: "en",
    target_language_input: "Spanish",
    target_language_code: "es",
    output_mode: "create_new_file" as const,
    range_mode: "entire" as const,
    range_expression: null,
    provider_route: null,
    status: "completed" as const,
    total_units_billed: 12,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    error_code: null,
    error_message: null,
    warnings: [],
    cancel_requested_at: null,
    started_at: new Date("2026-04-10T10:00:00.000Z"),
    completed_at: new Date("2026-04-10T10:01:00.000Z"),
  };
}

test("job handler returns completed_with_warnings payload with structured warnings", () => {
  const warnings: JobWarning[] = [
    {
      node_id: "node_1",
      slide_index: 2,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "possible_overflow",
    },
    {
      node_id: "node_1",
      slide_index: 2,
      archetype: "metric_card",
      risk_level: "high",
      risk_reason: "manual_review_recommended",
    },
  ];

  const response = __buildJobStatusResponseForTests({
    ...createBaseJob(),
    status: "completed_with_warnings",
    warnings,
  });

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed with 1 container requiring review. Review the highlighted Slides containers for layout fidelity.",
    warnings,
  });
});

test("job handler returns plain completed payload without warnings when none exist", () => {
  const response = __buildJobStatusResponseForTests(createBaseJob());

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed successfully.",
  });
});

test("job handler tolerates null warnings on historical rows without crashing", () => {
  const response = __buildJobStatusResponseForTests({
    ...createBaseJob(),
    status: "completed_with_warnings",
    warnings: null as unknown as JobWarning[],
  });

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed successfully.",
  });
});
