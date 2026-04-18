import test from "node:test";
import assert from "node:assert/strict";
import { __setKmsClientForTests } from "@translay/shared-config";
import type { JobId, JobSlideResult, JobWarning, UserId } from "@translay/shared-contracts";
import {
  __buildJobStatusResponseForTests,
  __extractBearerTokenForTests,
  __resolveHostOauthPersistenceForTests,
} from "./handler";

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
    provisionally_billed_units: 12,
    gross_billed_slides: 12,
    refunded_slides: 0,
    net_billed_slides: 12,
    total_units_billed: 12,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    error_code: null,
    error_message: null,
    warnings: [],
    cancel_requested_at: null,
    current_stage: null,
    stage_status: null,
    stage_cursor: {},
    stage_payload: {},
    stage_attempt: 0,
    stage_lease_expires_at: null,
    stage_last_heartbeat_at: null,
    queued_task_name: null,
    started_at: new Date("2026-04-10T10:00:00.000Z"),
    completed_at: new Date("2026-04-10T10:01:00.000Z"),
  };
}

function createSlideResult(overrides: Partial<JobSlideResult>): JobSlideResult {
  const bodyNodeCount = overrides.body_node_count ?? 1;
  const bodyWrittenNodeCount =
    overrides.body_written_node_count ??
    (overrides.content_output_visible || overrides.output_visible ? bodyNodeCount : 0);
  return {
    slide_index: 0,
    status: "pending",
    warning_codes: [],
    provisionally_billed: false,
    final_billable: false,
    refund_required: false,
    refunded: false,
    output_visible: false,
    content_output_visible: overrides.content_output_visible ?? overrides.output_visible ?? false,
    content_translated: overrides.content_translated ?? overrides.output_visible ?? false,
    notes_output_visible: overrides.notes_output_visible ?? false,
    notes_translated: overrides.notes_translated ?? false,
    body_node_count: bodyNodeCount,
    notes_node_count: overrides.notes_present ? 1 : 0,
    body_written_node_count: bodyWrittenNodeCount,
    body_failed_node_count: overrides.body_failed_node_count ?? 0,
    body_translated_node_count:
      overrides.body_translated_node_count ??
      (overrides.content_translated || overrides.content_output_visible || overrides.output_visible
        ? bodyNodeCount
        : 0),
    notes_written_node_count:
      overrides.notes_written_node_count ??
      (overrides.notes_output_visible ? 1 : 0),
    notes_failed_node_count: overrides.notes_failed_node_count ?? 0,
    notes_translated_node_count:
      overrides.notes_translated_node_count ??
      (overrides.notes_translated || overrides.notes_output_visible ? 1 : 0),
    ...overrides,
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

  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "completed_with_warnings",
      warnings,
    },
    [
      createSlideResult({
        slide_index: 0,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed with warnings. Review 1 container for layout fidelity.",
    fully_delivered_body_slide_indices: [1],
    content_only_slide_indices: [],
    notes_only_slide_indices: [],
    body_partial_slide_indices: [],
    skipped_slide_indices: [],
    refunded_slide_indices: [],
    total_billed_units: 12,
    gross_billed_slides: 12,
    refunded_slides: 0,
    net_billed_slides: 12,
    warnings,
  });
});

test("job handler surfaces skipped unsafe slides in completed-with-warnings message", () => {
  const warnings: JobWarning[] = [
    {
      node_id: "node_1",
      slide_index: 1,
      archetype: "plain_text",
      risk_level: "medium",
      risk_reason: "possible_overflow",
    },
    {
      node_id: "unsafe_slide_4",
      slide_index: 3,
      archetype: "plain_text",
      risk_level: "high",
      risk_reason: "unsafe_slide_excluded",
    },
    {
      node_id: "unsafe_slide_7",
      slide_index: 6,
      archetype: "plain_text",
      risk_level: "high",
      risk_reason: "unsafe_slide_excluded",
    },
  ];

  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "completed_with_warnings",
      gross_billed_slides: 3,
      refunded_slides: 0,
      net_billed_slides: 3,
      warnings,
    },
    [
      createSlideResult({
        slide_index: 0,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
      }),
      createSlideResult({
        slide_index: 3,
        status: "excluded_unsafe",
      }),
      createSlideResult({
        slide_index: 6,
        status: "excluded_unsafe",
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message:
      "Translation completed with warnings. Slides 4, 7 were skipped because their content looked unsafe for model input. Review 1 container for layout fidelity.",
    fully_delivered_body_slide_indices: [1],
    content_only_slide_indices: [],
    notes_only_slide_indices: [],
    body_partial_slide_indices: [],
    skipped_slide_indices: [4, 7],
    refunded_slide_indices: [],
    total_billed_units: 12,
    gross_billed_slides: 3,
    refunded_slides: 0,
    net_billed_slides: 3,
    warnings,
  });
});

test("job handler surfaces skipped unsafe slides in the completed message", () => {
  const warnings: JobWarning[] = [
    {
      node_id: "unsafe_slide_2",
      slide_index: 1,
      archetype: "plain_text",
      risk_level: "high",
      risk_reason: "unsafe_slide_excluded",
    },
    {
      node_id: "node_4",
      slide_index: 3,
      archetype: "plain_text",
      risk_level: "medium",
      risk_reason: "layout_semantics_fallback_applied",
    },
  ];

  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "completed_with_warnings",
      warnings,
    },
    [
      createSlideResult({
        slide_index: 1,
        status: "excluded_unsafe",
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message:
      "Translation completed with warnings. Slide 2 was skipped because its content looked unsafe for model input. Review 1 container for layout fidelity.",
    fully_delivered_body_slide_indices: [],
    content_only_slide_indices: [],
    notes_only_slide_indices: [],
    body_partial_slide_indices: [],
    skipped_slide_indices: [2],
    refunded_slide_indices: [],
    total_billed_units: 12,
    gross_billed_slides: 12,
    refunded_slides: 0,
    net_billed_slides: 12,
    warnings,
  });
});

test("job handler returns failed payload with persisted unsafe-slide warnings", () => {
  const warnings: JobWarning[] = [
    {
      node_id: "unsafe_slide_2",
      slide_index: 1,
      archetype: "plain_text",
      risk_level: "high",
      risk_reason: "unsafe_slide_excluded",
    },
  ];

  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "failed",
      gross_billed_slides: 2,
      refunded_slides: 1,
      net_billed_slides: 1,
      error_code: "JOB_INTERNAL_ERROR",
      error_message: "Translation failed.",
      warnings,
    },
    [
      createSlideResult({
        slide_index: 0,
        status: "translated",
        provisionally_billed: true,
        refund_required: true,
        refunded: true,
      }),
      createSlideResult({
        slide_index: 1,
        status: "excluded_unsafe",
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "failed",
    error: "JOB_INTERNAL_ERROR",
    message:
      "Translation failed. Refunded: slide 1. Slide 2 was skipped because its content looked unsafe for model input.",
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    total_billed_units: 12,
    skipped_slide_indices: [1, 2],
    refunded_slide_indices: [1],
    gross_billed_slides: 2,
    refunded_slides: 1,
    net_billed_slides: 1,
    warnings: [
      ...warnings,
      {
        node_id: "slide_result_1_refund",
        slide_index: 0,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_charge_refunded",
      },
    ],
  });
});

test("job handler returns plain completed payload without warnings when none exist", () => {
  const response = __buildJobStatusResponseForTests(
    createBaseJob(),
    [
      createSlideResult({
        slide_index: 0,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
      }),
      createSlideResult({
        slide_index: 1,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed successfully.",
    fully_delivered_body_slide_indices: [1, 2],
    content_only_slide_indices: [],
    notes_only_slide_indices: [],
    body_partial_slide_indices: [],
    skipped_slide_indices: [],
    refunded_slide_indices: [],
    total_billed_units: 12,
    gross_billed_slides: 12,
    refunded_slides: 0,
    net_billed_slides: 12,
  });
});

test("job handler exposes notes-only and partial not billed slide indices", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      total_units_billed: 13.5,
      gross_billed_slides: 14,
      refunded_slides: 0.5,
      net_billed_slides: 13.5,
    },
    [
      createSlideResult({
        slide_index: 0,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
        content_output_visible: true,
      }),
      createSlideResult({
        slide_index: 10,
        status: "committed",
        provisionally_billed: true,
        final_billable: true,
        output_visible: true,
        notes_present: true,
        notes_output_visible: true,
        content_output_visible: false,
        body_node_count: 2,
        body_written_node_count: 0,
        body_failed_node_count: 2,
        final_billed_units: 0.5,
      }),
      createSlideResult({
        slide_index: 11,
        status: "committed",
        provisionally_billed: false,
        final_billable: false,
        output_visible: true,
        content_output_visible: true,
        body_node_count: 3,
        body_written_node_count: 2,
        body_failed_node_count: 1,
        final_billed_units: 0,
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    completion_code: "PARTIAL_SUCCESS",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed with warnings. Notes-only fallback: slide 11. Partially translated slides: 12, not billed.",
    fully_delivered_body_slide_indices: [1],
    content_only_slide_indices: [],
    notes_only_slide_indices: [11],
    body_partial_slide_indices: [12],
    skipped_slide_indices: [],
    refunded_slide_indices: [],
    total_billed_units: 13.5,
    gross_billed_slides: 14,
    refunded_slides: 0.5,
    net_billed_slides: 13.5,
  });
});

test("job handler tolerates null warnings on historical rows without crashing", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "completed_with_warnings",
      warnings: null as unknown as JobWarning[],
    },
    [
      createSlideResult({
        slide_index: 2,
        status: "skipped_write_failed",
        failure_stage: "write",
        failure_reason_code: "HOST_ADAPTER_ERROR",
        provisionally_billed: true,
        refund_required: true,
        refunded: true,
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "completed_with_warnings",
    completion_code: "PARTIAL_SUCCESS",
    progress_percent: 100,
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    message: "Translation completed with warnings. Slide 3 could not be delivered due to translation or write-back issues and was refunded.",
    fully_delivered_body_slide_indices: [],
    content_only_slide_indices: [],
    notes_only_slide_indices: [],
    body_partial_slide_indices: [],
    skipped_slide_indices: [3],
    refunded_slide_indices: [3],
    total_billed_units: 12,
    gross_billed_slides: 12,
    refunded_slides: 0,
    net_billed_slides: 12,
    warnings: [
      {
        node_id: "slide_result_3",
        slide_index: 2,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_write_failed",
      },
      {
        node_id: "slide_result_3_refund",
        slide_index: 2,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_charge_refunded",
      },
    ],
  });
});

test("job handler does not surface refunded metadata for unsafe-excluded slides", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "failed",
      gross_billed_slides: 1,
      refunded_slides: 1,
      net_billed_slides: 0,
      error_code: "JOB_INTERNAL_ERROR",
      error_message: "Translation failed.",
    },
    [
      createSlideResult({
        slide_index: 4,
        status: "excluded_unsafe",
        refunded: true,
      }),
    ]
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "failed",
    error: "JOB_INTERNAL_ERROR",
    message: "Translation failed.",
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
    total_billed_units: 12,
    skipped_slide_indices: [5],
    gross_billed_slides: 1,
    refunded_slides: 1,
    net_billed_slides: 0,
  });
});

test("job handler returns in-progress billed slide count for cancel warnings", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "translating",
      provisionally_billed_units: 3,
      total_units_billed: 3,
      completed_at: null,
    },
    [],
    {
      status: "translating",
      progress_percent: "64",
      current_step: "materialization_pass",
      details: "Materialized batch 4 of 8. 3 slide(s) already count toward quota.",
    }
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "translating",
    progress_percent: 64,
    current_step: "materialization_pass",
    details: "Materialized batch 4 of 8. 3 slide(s) already count toward quota.",
    translated_units_billed: 3,
  });
});

test("job handler returns canceled payload with translated-slide billing message", () => {
  const response = __buildJobStatusResponseForTests({
    ...createBaseJob(),
    status: "canceled",
    provisionally_billed_units: 2,
    gross_billed_slides: 2,
    refunded_slides: 0,
    net_billed_slides: 2,
    total_units_billed: 2,
    completed_at: new Date("2026-04-10T10:01:00.000Z"),
  });

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "canceled",
    message:
      "Translation canceled after 2 slide(s) were successfully translated. Those slides were counted toward your quota even though the job did not finish.",
    total_units_billed: 2,
    output_mode: "create_new_file",
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
  });
});

test("job handler returns no-charge canceled message when net billed slides are zero", () => {
  const response = __buildJobStatusResponseForTests({
    ...createBaseJob(),
    status: "canceled",
    provisionally_billed_units: 2,
    gross_billed_slides: 2,
    refunded_slides: 2,
    net_billed_slides: 0,
    total_units_billed: 2,
    completed_at: new Date("2026-04-10T10:01:00.000Z"),
  });

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "canceled",
    message: "Translation canceled before any slide translation succeeded. No quota was charged.",
    total_units_billed: 0,
    output_mode: "create_new_file",
    output_document_url: "https://docs.google.com/presentation/d/target-doc/edit",
  });
});

test("extractBearerToken rejects missing, empty, and oversized bearer tokens", () => {
  assert.equal(__extractBearerTokenForTests(undefined), null);
  assert.equal(__extractBearerTokenForTests("Bearer   "), null);
  assert.equal(
    __extractBearerTokenForTests(`Bearer ${"x".repeat(8 * 1024 + 1)}`),
    null
  );
  assert.equal(__extractBearerTokenForTests("Bearer valid-token"), "valid-token");
});

test("resolveHostOauthPersistence returns null when authorization is missing", async () => {
  const resolved = await __resolveHostOauthPersistenceForTests(undefined);
  assert.equal(resolved, null);
});

test("resolveHostOauthPersistence stores encrypted token metadata when KMS succeeds", async () => {
  const resolved = await __resolveHostOauthPersistenceForTests("Bearer host-token", {
    encrypt: async (plaintext) => {
      assert.equal(String(plaintext), "host-token");
      return Buffer.from("ciphertext");
    },
    nowMs: () => Date.parse("2026-04-18T10:00:00.000Z"),
  });

  assert.deepEqual(resolved, {
    encryptedHostOauthToken: Buffer.from("ciphertext"),
    hostOauthTokenExpiresAt: new Date("2026-04-18T10:55:00.000Z"),
    hostOauthSource: "addon",
  });
});

test("resolveHostOauthPersistence falls back to service account when KMS encrypt fails", async () => {
  const seenErrors: string[] = [];
  const resolved = await __resolveHostOauthPersistenceForTests("Bearer host-token", {
    encrypt: async () => {
      throw new Error("kms unavailable");
    },
    onEncryptError: (error) => {
      seenErrors.push(error instanceof Error ? error.message : String(error));
    },
  });

  assert.deepEqual(resolved, {
    encryptedHostOauthToken: null,
    hostOauthTokenExpiresAt: null,
    hostOauthSource: "sa_fallback",
  });
  assert.deepEqual(seenErrors, ["kms unavailable"]);
});

test("KMS test hooks are disabled in production-like environments", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "staging";

  try {
    assert.throws(
      () => __setKmsClientForTests(null),
      /production-like environments/
    );
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});
