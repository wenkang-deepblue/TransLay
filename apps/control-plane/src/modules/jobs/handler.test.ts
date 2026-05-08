import test from "node:test";
import assert from "node:assert/strict";
import { __setKmsClientForTests } from "@translay/shared-config";
import type { AppConfig } from "@translay/shared-config";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { JobId, JobSlideResult, JobWarning, UserId } from "@translay/shared-contracts";
import {
  __buildJobStatusResponseForTests,
  __extractBearerTokenForTests,
  __resetDriveCleanupRetryHooksForTests,
  __resolveHostOauthPersistenceForTests,
  __setDriveCleanupRetryHooksForTests,
  createJobHandler,
  previewJobHandler,
  registerPreparedDriveCleanupHandler,
  clearPreparedDriveCleanupHandler,
  retryJobDriveCleanupHandler,
  retryPendingDriveCleanupHandler,
} from "./handler";

function createRedisMock(overrides: Record<string, unknown> = {}): Redis {
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    ...overrides,
  } as unknown as Redis;
}

function createBaseJob() {
  return {
    id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" as JobId,
    user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId,
    host_type: "slides" as const,
    source_doc_id: "source-doc",
    source_doc_name: "Quarterly deck",
    target_doc_id: "target-doc",
    source_worker_permission_id: "source-permission",
    target_worker_permission_id: "target-permission",
    drive_cleanup_status: "succeeded" as const,
    drive_cleanup_attempts: 1,
    drive_cleanup_last_error_code: null,
    drive_cleanup_last_attempt_at: null,
    drive_cleanup_completed_at: null,
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

test("job handler surfaces pausing progress from redis without losing billed-unit progress", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "translating",
      provisionally_billed_units: 2.5,
      total_units_billed: 2.5,
      completed_at: null,
    },
    [],
    {
      status: "pausing",
      progress_percent: "64",
      current_step: "pausing",
      details: "Pause requested. The worker will pause at the next safe checkpoint.",
    }
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "pausing",
    progress_percent: 64,
    translated_units_billed: 2.5,
    current_step: "pausing",
    details: "Pause requested. The worker will pause at the next safe checkpoint.",
  });
});

test("job handler surfaces paused progress from redis while keeping current stage metadata", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "translating",
      current_stage: "authority",
      stage_status: "running",
      stage_attempt: 4,
      provisionally_billed_units: 5,
      total_units_billed: 5,
      completed_at: null,
    },
    [],
    {
      status: "paused",
      progress_percent: "82",
      current_step: "paused",
      details: "Translation paused. Confirm cancellation or continue to resume.",
    }
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "paused",
    progress_percent: 82,
    translated_units_billed: 5,
    current_stage: "authority",
    stage_status: "running",
    stage_attempt: 4,
    current_step: "paused",
    details: "Translation paused. Confirm cancellation or continue to resume.",
  });
});

test("job handler ignores terminal redis status until the database job is terminal", () => {
  const response = __buildJobStatusResponseForTests(
    {
      ...createBaseJob(),
      status: "translating",
      provisionally_billed_units: 5,
      total_units_billed: 5,
      completed_at: null,
    },
    [],
    {
      status: "completed_with_warnings",
      progress_percent: "100",
      current_step: "finalize",
      details: "Translation completed with warnings.",
    }
  );

  assert.deepEqual(response, {
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
    status: "translating",
    progress_percent: 100,
    translated_units_billed: 5,
    current_step: "finalize",
    details: "Translation completed with warnings.",
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

function getInsertParamByColumn(
  insert: { sql: string; params: unknown[] | undefined },
  columnName: string
): unknown {
  const match = insert.sql.match(/INSERT INTO translation_jobs\s*\(([\s\S]*?)\)\s*VALUES/i);
  assert.ok(match, "expected explicit translation_jobs insert columns");
  const columns = match[1]!
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const index = columns.indexOf(columnName);
  assert.notEqual(index, -1, `expected insert column ${columnName}`);
  return insert.params?.[index];
}

async function runCreateJobUntilAccepted(
  body: Record<string, unknown>,
  options: {
    readonly existingIdempotencyJob?: ReturnType<typeof createBaseJob> | {
      readonly [key: string]: unknown;
      readonly id: JobId | string;
    };
  } = {}
) {
  const poolCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const clientCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const enqueueCalls: Array<{ jobId: JobId | string; stage: string; stageAttempt: number }> = [];
  let unresolvedCleanupCalls = 0;
  let redisGetCalls = 0;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      poolCalls.push({ sql, params });
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM idempotency_records")) {
        if (options.existingIdempotencyJob) {
          return { rows: [{ job_id: options.existingIdempotencyJob.id }] };
        }
        return { rows: [] };
      }
      if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
        return {
          rows: options.existingIdempotencyJob ? [options.existingIdempotencyJob] : [],
        };
      }
      if (sql.includes("DELETE FROM idempotency_records")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        unresolvedCleanupCalls += 1;
        return { rows: [] };
      }
      if (sql.includes("status IN ('pending', 'queued', 'extracting', 'translating', 'writing')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "free",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: null,
            provider_subscription_id: null,
            current_period_start: null,
            current_period_end: null,
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 0,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      if (sql.includes("UPDATE translation_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        clientCalls.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT 1 FROM translation_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("COUNT(*)::int AS n")) {
          return { rows: [{ n: "0" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO translation_jobs")) {
          return { rows: [{ id: "job-1" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO idempotency_records")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    }),
  } as unknown as Pool;

  const redis = createRedisMock({
    get: async () => {
      redisGetCalls += 1;
      return null;
    },
    multi: () => ({
      hset() {
        return this;
      },
      expire() {
        return this;
      },
      exec: async () => [[null, 1], [null, 1]],
    }),
  });

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(responseBody: Record<string, unknown>) {
      payload = responseBody;
      return this;
    },
  } as never;

  await createJobHandler(
    pool,
    redis,
    {
      jobs: { maxGlobalInFlightJobs: 50 },
      cloudTasks: {
        workerUrl: "",
        invokerServiceAccount: "worker-invoker@example.com",
      },
    } as AppConfig,
    {
      enqueueJob: async (_config, jobId, stage, stageAttempt) => {
        enqueueCalls.push({
          jobId,
          stage: stage ?? "extract",
          stageAttempt: stageAttempt ?? 1,
        });
        return `tasks/${jobId}-${stage ?? "extract"}-${stageAttempt ?? 1}`;
      },
    }
  )(
    {
      authContext: { user_id: "user-1" as UserId },
      headers: { authorization: "Bearer host-token" },
      body,
    } as never,
    res
  );

  return {
    statusCode,
    payload,
    poolCalls,
    clientCalls,
    enqueueCalls,
    redisGetCalls,
    unresolvedCleanupCalls,
  };
}

test("createJobHandler persists null permission ids for user-OAuth-only append jobs", async () => {
  const result = await runCreateJobUntilAccepted({
    host_type: "slides",
    document_id: "source-doc",
    document_name: "Quarterly deck",
    source_language_mode: "auto",
    target_language_input: "French",
    output_mode: "append_in_file",
    range_mode: "custom",
    range_expression: "1",
    idempotency_key: "idem-no-drive-append",
  });

  const insert = result.clientCalls.find((call) => call.sql.includes("INSERT INTO translation_jobs"));
  assert.ok(insert, "expected translation job insert");
  assert.equal(getInsertParamByColumn(insert!, "target_doc_id"), null);
  assert.equal(getInsertParamByColumn(insert!, "source_worker_permission_id"), null);
  assert.equal(getInsertParamByColumn(insert!, "target_worker_permission_id"), null);
  assert.equal(getInsertParamByColumn(insert!, "drive_cleanup_status"), "not_required");
  assert.equal(result.unresolvedCleanupCalls, 0);
  assert.equal(result.redisGetCalls, 0);
  assert.deepEqual(result.enqueueCalls, [{ jobId: "job-1", stage: "extract", stageAttempt: 1 }]);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.payload, {
    status: "accepted",
    job_id: "job-1",
    queued: true,
  });
});

test("createJobHandler persists null permission ids for user-OAuth-only create-new-file jobs", async () => {
  const result = await runCreateJobUntilAccepted({
    host_type: "slides",
    document_id: "source-doc",
    document_name: "Quarterly deck",
    target_document_id: "target-doc",
    source_language_mode: "auto",
    target_language_input: "French",
    output_mode: "create_new_file",
    range_mode: "custom",
    range_expression: "1",
    idempotency_key: "idem-no-drive-new-file",
  });

  const insert = result.clientCalls.find((call) => call.sql.includes("INSERT INTO translation_jobs"));
  assert.ok(insert, "expected translation job insert");
  assert.equal(getInsertParamByColumn(insert!, "target_doc_id"), "target-doc");
  assert.equal(getInsertParamByColumn(insert!, "source_worker_permission_id"), null);
  assert.equal(getInsertParamByColumn(insert!, "target_worker_permission_id"), null);
  assert.equal(getInsertParamByColumn(insert!, "drive_cleanup_status"), "not_required");
  assert.equal(result.unresolvedCleanupCalls, 0);
  assert.equal(result.redisGetCalls, 0);
  assert.deepEqual(result.enqueueCalls, [{ jobId: "job-1", stage: "extract", stageAttempt: 1 }]);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.payload, {
    status: "accepted",
    job_id: "job-1",
    queued: true,
  });
});

test("createJobHandler does not apply old cleanup blocking to user-OAuth-only idempotency reuse", async () => {
  const result = await runCreateJobUntilAccepted(
    {
      host_type: "slides",
      document_id: "source-doc",
      document_name: "Quarterly deck",
      source_language_mode: "auto",
      target_language_input: "French",
      output_mode: "append_in_file",
      range_mode: "custom",
      range_expression: "1",
      idempotency_key: "idem-no-drive-after-old-cleanup",
    },
    {
      existingIdempotencyJob: {
        ...createBaseJob(),
        id: "old-job-with-cleanup" as JobId,
        status: "failed",
        source_worker_permission_id: "source-permission",
        target_worker_permission_id: null,
        drive_cleanup_status: "pending",
      },
    }
  );

  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.payload, {
    status: "accepted",
    job_id: "job-1",
    queued: true,
  });
  assert.equal(result.unresolvedCleanupCalls, 0);
  assert.equal(result.redisGetCalls, 0);
  assert.ok(
    result.poolCalls.some((call) => call.sql.includes("DELETE FROM idempotency_records")),
    "expected stale idempotency record to be removed before accepting no-Drive job"
  );
});

test("createJobHandler does not delete an idempotency record while Drive cleanup is pending", async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [{ job_id: "job-1" }] };
      }
      if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
        return {
          rows: [{
            ...createBaseJob(),
            id: "job-1",
            status: "failed",
            drive_cleanup_status: "pending",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => {
      throw new Error("job creation should not run while cleanup is pending");
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await createJobHandler(
    pool,
    createRedisMock(),
    { jobs: { maxGlobalInFlightJobs: 50 } } as AppConfig
  )(
    {
      authContext: { user_id: "user-1" as UserId },
      headers: { authorization: "Bearer host-token" },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        document_name: "Quarterly deck",
        source_language_mode: "auto",
        target_language_input: "French",
        output_mode: "append_in_file",
        range_mode: "custom",
        range_expression: "1",
        drive_access: {
          source_worker_permission_id: "source-permission",
        },
        idempotency_key: "idem-1",
      },
    } as never,
    res
  );

  assert.equal(statusCode, 409);
  assert.deepEqual(payload, {
    error: "DRIVE_CLEANUP_REQUIRED",
    message: "A previous request for this presentation still has pending temporary access cleanup.",
  });
  assert.equal(calls.some((sql) => sql.includes("DELETE FROM idempotency_records")), false);
});

test("createJobHandler blocks unresolved Drive cleanup even without an idempotency record", async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return {
          rows: [{
            ...createBaseJob(),
            id: "orphan-cleanup-job",
            status: "failed",
            drive_cleanup_status: "failed",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => {
      throw new Error("job creation should not run while cleanup is unresolved");
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await createJobHandler(
    pool,
    createRedisMock(),
    { jobs: { maxGlobalInFlightJobs: 50 } } as AppConfig
  )(
    {
      authContext: { user_id: "user-1" as UserId },
      headers: { authorization: "Bearer host-token" },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        document_name: "Quarterly deck",
        source_language_mode: "auto",
        target_language_input: "French",
        output_mode: "append_in_file",
        range_mode: "custom",
        range_expression: "1",
        drive_access: {
          source_worker_permission_id: "source-permission",
        },
        idempotency_key: "idem-new",
      },
    } as never,
    res
  );

  assert.equal(statusCode, 409);
  assert.deepEqual(payload, {
    error: "DRIVE_CLEANUP_REQUIRED",
    message: "A previous request for this presentation still has pending temporary access cleanup.",
  });
  assert.equal(calls.some((sql) => sql.includes("DELETE FROM idempotency_records")), false);
});

test("createJobHandler does not treat resubmit as cleanup recovery", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [{ id: "completed-job" }] };
      }
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return {
          rows: [{
            ...createBaseJob(),
            id: "cleanup-job",
            status: "completed",
            drive_cleanup_status: "failed",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => {
      throw new Error("job creation should not run while cleanup is unresolved");
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await createJobHandler(
    pool,
    createRedisMock(),
    { jobs: { maxGlobalInFlightJobs: 50 } } as AppConfig
  )(
    {
      authContext: { user_id: "user-1" as UserId },
      headers: { authorization: "Bearer host-token" },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        document_name: "Quarterly deck",
        source_language_mode: "auto",
        target_language_input: "French",
        output_mode: "append_in_file",
        range_mode: "custom",
        range_expression: "1",
        drive_access: {
          source_worker_permission_id: "source-permission",
        },
        idempotency_key: "idem-resubmit",
        resubmit: true,
      },
    } as never,
    res
  );

  assert.equal(statusCode, 409);
  assert.deepEqual(payload, {
    error: "DRIVE_CLEANUP_REQUIRED",
    message: "A previous request for this presentation still has pending temporary access cleanup.",
  });
});

test("retryJobDriveCleanupHandler revokes stored permissions and marks cleanup succeeded", async () => {
  const fetchCalls: Array<{ url: string; method: string | undefined; authorization: string | undefined }> = [];
  __setDriveCleanupRetryHooksForTests({
    fetch: (async (input, init) => {
      fetchCalls.push({
        url: String(input),
        method: init?.method,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch,
    sleep: async () => {},
  });

  try {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
          return {
            rows: [{
              ...createBaseJob(),
              drive_cleanup_status: "failed",
              drive_cleanup_attempts: 1,
            }],
          };
        }
        if (sql.includes("UPDATE translation_jobs")) {
          assert.deepEqual(params, [
            "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
            "succeeded",
            null,
            "a8b96255-d4ef-47ee-bf43-b53fdc318c9d",
          ]);
          return {
            rows: [{
              ...createBaseJob(),
              drive_cleanup_status: "succeeded",
              drive_cleanup_attempts: 2,
              drive_cleanup_last_error_code: null,
            }],
          };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    let statusCode = 200;
    let payload: Record<string, unknown> | null = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        payload = body;
        return this;
      },
    } as never;

    await retryJobDriveCleanupHandler(pool)(
      {
        authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
        headers: { authorization: "Bearer fresh-host-token" },
        params: { jobId: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" },
      } as never,
      res
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(payload, {
      job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
      drive_cleanup_status: "succeeded",
      drive_cleanup_attempts: 2,
      message: "Temporary access cleanup succeeded.",
    });
    assert.deepEqual(fetchCalls, [
      {
        url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
        method: "DELETE",
        authorization: "Bearer fresh-host-token",
      },
      {
        url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true",
        method: "DELETE",
        authorization: "Bearer fresh-host-token",
      },
    ]);
  } finally {
    __resetDriveCleanupRetryHooksForTests();
  }
});

test("retryJobDriveCleanupHandler cleans distinct permissions on the same Drive file", async () => {
  const fetchCalls: string[] = [];
  __setDriveCleanupRetryHooksForTests({
    fetch: (async (input) => {
      fetchCalls.push(String(input));
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch,
    sleep: async () => {},
  });

  try {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
          return {
            rows: [{
              ...createBaseJob(),
              target_doc_id: "source-doc",
              source_worker_permission_id: "source-permission",
              target_worker_permission_id: "target-permission",
              drive_cleanup_status: "failed",
            }],
          };
        }
        if (sql.includes("UPDATE translation_jobs")) {
          return {
            rows: [{
              ...createBaseJob(),
              drive_cleanup_status: "succeeded",
              drive_cleanup_attempts: 1,
            }],
          };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    await retryJobDriveCleanupHandler(pool)(
      {
        authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
        headers: { authorization: "Bearer fresh-host-token" },
        params: { jobId: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" },
      } as never,
      { status() { return this; }, json() { return this; } } as never
    );

    assert.deepEqual(fetchCalls, [
      "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
      "https://www.googleapis.com/drive/v3/files/source-doc/permissions/target-permission?supportsAllDrives=true",
    ]);
  } finally {
    __resetDriveCleanupRetryHooksForTests();
  }
});

test("retryJobDriveCleanupHandler retries transient Drive cleanup failures", async () => {
  const sleepCalls: number[] = [];
  let attempts = 0;
  __setDriveCleanupRetryHooksForTests({
    fetch: (async () => {
      attempts += 1;
      return attempts === 1
        ? ({ ok: false, status: 429 } as Response)
        : ({ ok: true, status: 204 } as Response);
    }) as typeof fetch,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  try {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
          return {
            rows: [{
              ...createBaseJob(),
              target_worker_permission_id: null,
              drive_cleanup_status: "failed",
            }],
          };
        }
        if (sql.includes("UPDATE translation_jobs")) {
          return {
            rows: [{
              ...createBaseJob(),
              drive_cleanup_status: "succeeded",
              drive_cleanup_attempts: 1,
            }],
          };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    await retryJobDriveCleanupHandler(pool)(
      {
        authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
        headers: { authorization: "Bearer fresh-host-token" },
        params: { jobId: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" },
      } as never,
      { status() { return this; }, json() { return this; } } as never
    );

    assert.equal(attempts, 2);
    assert.deepEqual(sleepCalls, [500]);
  } finally {
    __resetDriveCleanupRetryHooksForTests();
  }
});

test("retryPendingDriveCleanupHandler records failed cleanup when Drive refuses deletion", async () => {
  __setDriveCleanupRetryHooksForTests({
    fetch: (async () => ({ ok: false, status: 403 }) as Response) as typeof fetch,
    sleep: async () => {},
  });

  try {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM translation_jobs") && sql.includes("ORDER BY started_at")) {
          assert.deepEqual(params, [
            "a8b96255-d4ef-47ee-bf43-b53fdc318c9d",
            "source-doc",
          ]);
          return {
            rows: [{
              ...createBaseJob(),
              status: "completed",
              drive_cleanup_status: "failed",
              drive_cleanup_attempts: 2,
            }],
          };
        }
        if (sql.includes("UPDATE translation_jobs")) {
          assert.deepEqual(params, [
            "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
            "failed",
            "drive_cleanup_forbidden",
            "a8b96255-d4ef-47ee-bf43-b53fdc318c9d",
          ]);
          return {
            rows: [{
              ...createBaseJob(),
              drive_cleanup_status: "failed",
              drive_cleanup_attempts: 3,
              drive_cleanup_last_error_code: "drive_cleanup_forbidden",
            }],
          };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    let statusCode = 200;
    let payload: Record<string, unknown> | null = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        payload = body;
        return this;
      },
    } as never;

    await retryPendingDriveCleanupHandler(pool, createRedisMock())(
      {
        authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
        headers: { authorization: "Bearer fresh-host-token" },
        body: { document_id: "source-doc" },
      } as never,
      res
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(payload, {
      job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
      drive_cleanup_status: "failed",
      drive_cleanup_attempts: 3,
      drive_cleanup_last_error_code: "drive_cleanup_forbidden",
      message: "Temporary access cleanup is still pending. Please retry or contact support with the task ID.",
    });
  } finally {
    __resetDriveCleanupRetryHooksForTests();
  }
});

test("retryPendingDriveCleanupHandler cleans prepared metadata when no job row exists", async () => {
  const fetchCalls: Array<{ url: string; method: string | undefined; body?: unknown }> = [];
  __setDriveCleanupRetryHooksForTests({
    fetch: (async (input, init) => {
      fetchCalls.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
      });
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch,
    sleep: async () => {},
  });

  try {
    let deletedKey: string | null = null;
    const redis = createRedisMock({
      get: async () => JSON.stringify({
        source_doc_id: "source-doc",
        source_worker_permission_id: "source-permission",
        target_doc_id: "target-doc",
        target_worker_permission_id: "target-permission",
        target_was_copied_by_addon: true,
        drive_cleanup_attempts: 0,
        drive_cleanup_last_error_code: null,
        registered_at: "2026-05-07T00:00:00.000Z",
      }),
      del: async (key: string) => {
        deletedKey = key;
        return 1;
      },
    });
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("drive_cleanup_status IN")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    let payload: Record<string, unknown> | null = null;
    const res = {
      status() { return this; },
      json(body: Record<string, unknown>) {
        payload = body;
        return this;
      },
    } as never;

    await retryPendingDriveCleanupHandler(pool, redis)(
      {
        authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
        headers: { authorization: "Bearer fresh-host-token" },
        body: { document_id: "source-doc" },
      } as never,
      res
    );

    assert.deepEqual(payload, {
      job_id: null,
      drive_cleanup_status: "succeeded",
      drive_cleanup_attempts: 1,
      message: "Temporary access cleanup succeeded.",
    });
    assert.equal(deletedKey, "jobs:prepared-drive-cleanup:a8b96255-d4ef-47ee-bf43-b53fdc318c9d:source-doc");
    assert.deepEqual(fetchCalls, [
      {
        url: "https://www.googleapis.com/drive/v3/files/source-doc/permissions/source-permission?supportsAllDrives=true",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://www.googleapis.com/drive/v3/files/target-doc/permissions/target-permission?supportsAllDrives=true",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://www.googleapis.com/drive/v3/files/target-doc?supportsAllDrives=true",
        method: "PATCH",
        body: JSON.stringify({ trashed: true }),
      },
    ]);
  } finally {
    __resetDriveCleanupRetryHooksForTests();
  }
});

test("registerPreparedDriveCleanupHandler stores bounded cleanup metadata", async () => {
  let storedKey: string | null = null;
  let storedValue: string | null = null;
  let storedTtl: number | null = null;
  const redis = createRedisMock({
    set: async (key: string, value: string, mode: string, ttl: number) => {
      storedKey = key;
      storedValue = value;
      storedTtl = mode === "EX" ? ttl : null;
      return "OK";
    },
  });

  await registerPreparedDriveCleanupHandler(redis)(
    {
      authContext: { user_id: "user-1" as UserId },
      body: {
        document_id: "source-doc",
        source_worker_permission_id: "source-permission",
        target_document_id: "target-doc",
        target_worker_permission_id: "target-permission",
        target_was_copied_by_addon: true,
      },
    } as never,
    { status() { return this; }, json() { return this; } } as never
  );

  assert.equal(storedKey, "jobs:prepared-drive-cleanup:user-1:source-doc");
  assert.equal(storedTtl, 24 * 60 * 60);
  assert.equal(JSON.parse(storedValue!).source_doc_id, "source-doc");
  assert.equal(JSON.parse(storedValue!).target_was_copied_by_addon, true);
});

test("clearPreparedDriveCleanupHandler deletes prepared cleanup metadata", async () => {
  let deletedKey: string | null = null;
  const redis = createRedisMock({
    del: async (key: string) => {
      deletedKey = key;
      return 1;
    },
  });

  await clearPreparedDriveCleanupHandler(redis)(
    {
      authContext: { user_id: "user-1" as UserId },
      body: { document_id: "source-doc" },
    } as never,
    { status() { return this; }, json() { return this; } } as never
  );

  assert.equal(deletedKey, "jobs:prepared-drive-cleanup:user-1:source-doc");
});

test("retryJobDriveCleanupHandler rejects ID tokens before attempting Drive cleanup", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM translation_jobs WHERE id = $1 AND user_id = $2")) {
        return {
          rows: [{
            ...createBaseJob(),
            drive_cleanup_status: "failed",
          }],
        };
      }
      if (sql.includes("UPDATE translation_jobs")) {
        throw new Error("cleanup attempts should not be recorded for ID tokens");
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await retryJobDriveCleanupHandler(pool)(
    {
      authContext: { user_id: "a8b96255-d4ef-47ee-bf43-b53fdc318c9d" as UserId },
      headers: { authorization: "Bearer header.payload.signature" },
      params: { jobId: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8" },
    } as never,
    res
  );

  assert.equal(statusCode, 401);
  assert.deepEqual(payload, {
    error: "INVALID_TOKEN",
    message: "Token verification failed",
  });
});

test("createJobHandler preserves cleanup metadata and idempotency when enqueue fails", async () => {
  const poolCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const clientCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      poolCalls.push({ sql, params });
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('pending', 'queued', 'extracting', 'translating', 'writing')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "free",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: null,
            provider_subscription_id: null,
            current_period_start: null,
            current_period_end: null,
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 0,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      if (sql.includes("UPDATE translation_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        clientCalls.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT 1 FROM translation_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("COUNT(*)::int AS n")) {
          return { rows: [{ n: "0" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO translation_jobs")) {
          return { rows: [{ id: "job-1" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO idempotency_records")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    }),
  } as unknown as Pool;

  const redis = createRedisMock({
    multi: () => ({
      hset() {
        return this;
      },
      expire() {
        return this;
      },
      exec: async () => [[null, 1], [null, 1]],
    }),
  });

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await createJobHandler(
    pool,
    redis,
    {
      jobs: { maxGlobalInFlightJobs: 50 },
      cloudTasks: {
        workerUrl: "",
        invokerServiceAccount: "worker-invoker@example.com",
      },
    } as AppConfig
  )(
    {
      authContext: { user_id: "user-1" as UserId },
      headers: { authorization: "Bearer host-token" },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        document_name: "Quarterly deck",
        source_language_mode: "auto",
        target_language_input: "French",
        output_mode: "append_in_file",
        range_mode: "custom",
        range_expression: "1",
        drive_access: {
          source_worker_permission_id: "source-permission",
        },
        idempotency_key: "idem-1",
      },
    } as never,
    res
  );

  const failedUpdate = poolCalls.find((call) => call.params?.[1] === "failed");
  assert.equal(statusCode, 500);
  assert.deepEqual(payload, {
    error: "JOB_INTERNAL_ERROR",
    message: "Failed to enqueue job for processing. Please retry.",
  });
  assert.ok(failedUpdate, "expected failed job update");
  assert.doesNotMatch(failedUpdate!.sql, /host_oauth_access_token_enc = NULL/);
  assert.doesNotMatch(failedUpdate!.sql, /host_oauth_token_expires_at = NULL/);
  assert.doesNotMatch(failedUpdate!.sql, /host_oauth_purged_at = NOW\(\)/);
  assert.equal(poolCalls.some((call) => call.sql.includes("DELETE FROM idempotency_records")), false);
  assert.equal(clientCalls.some((call) => call.sql.includes("INSERT INTO idempotency_records")), true);
});

test("createJobHandler returns a partial quota option when selected slides exceed remaining quota", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('pending', 'queued', 'extracting', 'translating', 'writing')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "pro_yearly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-24T09:37:58.441Z"),
            current_period_end: new Date("2027-04-24T09:37:58.441Z"),
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "495.0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 1,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => {
      throw new Error("job admission should not run when quota is exceeded");
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  const req = {
    authContext: { user_id: "user-1" as UserId },
    headers: { authorization: "Bearer host-token" },
    body: {
      host_type: "slides",
      document_id: "source-doc",
      document_name: "Quarterly deck",
      source_language_mode: "auto",
      target_language_input: "French",
      output_mode: "append_in_file",
      range_mode: "custom",
      range_expression: "1~10",
      drive_access: {
        source_worker_permission_id: "source-permission",
      },
      idempotency_key: "idem-1",
    },
  } as never;

  await createJobHandler(
    pool,
    createRedisMock(),
    { jobs: { maxGlobalInFlightJobs: 50 } } as AppConfig
  )(req, res);

  assert.equal(statusCode, 403);
  assert.deepEqual(payload, {
    ok: false,
    error: "QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION",
    message: "Usage quota is insufficient, but part of the selected Slides range can continue",
    required_units: 10,
    available_units: 5,
    allowed_range_expression: "1~5",
    excluded_range_expression: "6~10",
    cta: {
      upgrade_subscription: true,
      buy_credits: true,
    },
  });
});

test("previewJobHandler returns allowed and excluded ranges for partial quota continuation", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "pro_yearly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-24T09:37:58.441Z"),
            current_period_end: new Date("2027-04-24T09:37:58.441Z"),
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "491.0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 1,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await previewJobHandler(pool, createRedisMock())(
    {
      authContext: { user_id: "user-1" as UserId },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        range_mode: "custom",
        range_expression: "2~5, 8, 9~15, 20~22",
      },
    } as never,
    res
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(payload, {
    ok: false,
    error: "QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION",
    message: "Usage quota is insufficient, but part of the selected Slides range can continue",
    required_units: 15,
    available_units: 9,
    allowed_range_expression: "2~5, 8, 9~12",
    excluded_range_expression: "13~15, 20~22",
    cta: {
      upgrade_subscription: true,
      buy_credits: true,
    },
  });
});

test("previewJobHandler blocks unresolved Drive cleanup before quota preview", async () => {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("drive_cleanup_status IN")) {
        assert.deepEqual(params, ["user-1", "source-doc"]);
        return {
          rows: [{
            ...createBaseJob(),
            user_id: "user-1",
            source_doc_id: "source-doc",
            drive_cleanup_status: "failed",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await previewJobHandler(pool, createRedisMock())(
    {
      authContext: { user_id: "user-1" as UserId },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        range_mode: "custom",
        range_expression: "1~3",
      },
    } as never,
    res
  );

  assert.equal(statusCode, 409);
  assert.deepEqual(payload, {
    error: "DRIVE_CLEANUP_REQUIRED",
    message: "A previous request for this presentation still has pending temporary access cleanup.",
  });
});

test("previewJobHandler truncates sparse custom Slides ranges to the remaining quota", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "pro_yearly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-24T09:37:58.441Z"),
            current_period_end: new Date("2027-04-24T09:37:58.441Z"),
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "492.0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 1,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  } as unknown as Pool;

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  await previewJobHandler(pool, createRedisMock())(
    {
      authContext: { user_id: "user-1" as UserId },
      body: {
        host_type: "slides",
        document_id: "source-doc",
        range_mode: "custom",
        range_expression: "2, 5-7, 9-11, 14, 18-22",
      },
    } as never,
    res
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(payload, {
    ok: false,
    error: "QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION",
    message: "Usage quota is insufficient, but part of the selected Slides range can continue",
    required_units: 13,
    available_units: 8,
    allowed_range_expression: "2, 5~7, 9~11, 14",
    excluded_range_expression: "18~22",
    cta: {
      upgrade_subscription: true,
      buy_credits: true,
    },
  });
});

test("createJobHandler returns JOB_QUEUE_BUSY when the global in-flight gate is full", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('pending', 'queued', 'extracting', 'translating', 'writing')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "free",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: null,
            provider_subscription_id: null,
            current_period_start: null,
            current_period_end: null,
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 0,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT 1 FROM translation_jobs")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("COUNT(*)::int AS n")) {
          return { rows: [{ n: "50" }], rowCount: 1 };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    }),
  } as unknown as Pool;

  const redis = createRedisMock();
  const config: AppConfig = {
    port: 8080,
    nodeEnv: "test",
    gcpProjectId: "YOUR_GCP_PROJECT_ID",
    gcpRegion: "us-central1",
    db: {
      host: "localhost",
      port: 5432,
      name: "translay",
      user: "postgres",
      password: "postgres",
      poolMax: 20,
    },
    redis: {
      host: "localhost",
      port: 6379,
    },
    cloudTasks: {
      queueName: "YOUR_CLOUD_TASKS_QUEUE",
      location: "us-central1",
      workerUrl: "https://worker.example.com",
      audience: "https://worker.example.com/tasks/translate",
      invokerServiceAccount: "worker-invoker@example.com",
    },
    session: {
      secret: "x".repeat(32),
      cookieName: "__session",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    domain: "your-domain.example.com",
    publicAuth: {
      googleWebClientId: "",
      googleIdTokenAudiences: [],
    },
    billing: {
      providerName: "paddle",
      paddle: {
        environment: "sandbox",
        clientToken: "test_client_token",
        apiKey: "pdl_test_api_key",
        webhookSecret: "whsec_test_secret",
        priceIds: {
          pro_monthly: "pri_monthly_123",
          pro_yearly: "pri_yearly_456",
          credits_slides: "pri_credits_slide",
        },
        priceAmounts: {
          pro_monthly: 999,
          pro_yearly: 11999,
          credits_slides: 4,
        },
        creditSkus: {
          slides: {
            unit: "slides_pages",
            minUnits: 1,
            maxUnits: 100,
            priceId: "pri_credits_slide",
            amountCents: 4,
            minimumChargeAmountCents: 70,
          },
        },
        webhookToleranceSeconds: 300,
      },
    },
    entitlementCacheTtl: 300,
    jobs: {
      maxGlobalInFlightJobs: 50,
    },
    rateLimits: {
      global: { windowSeconds: 60, maxRequests: 1200 },
      userWrite: { windowSeconds: 60, maxRequests: 30 },
      userRead: { windowSeconds: 60, maxRequests: 120 },
    },
    security: {
      kmsKeyName: null,
      internalCronSecret: null,
    },
  };

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  const req = {
    authContext: { user_id: "user-1" as UserId },
    headers: { authorization: "Bearer host-token" },
    body: {
      host_type: "slides",
      document_id: "source-doc",
      document_name: "Quarterly deck",
      source_language_mode: "auto",
      target_language_input: "French",
      output_mode: "append_in_file",
      range_mode: "custom",
      range_expression: "1",
      drive_access: {
        source_worker_permission_id: "source-permission",
      },
      idempotency_key: "idem-1",
    },
  } as never;

  await createJobHandler(pool, redis, config)(req, res);

  assert.equal(statusCode, 429);
  assert.deepEqual(payload, {
    error: "JOB_QUEUE_BUSY",
    message: "The translation queue is currently busy",
  });
});

test("createJobHandler returns CONCURRENT_JOB_RUNNING when atomic admission sees same-user work", async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM idempotency_records")) {
        return { rows: [] };
      }
      if (sql.includes("drive_cleanup_status IN")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('completed', 'completed_with_warnings')")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('pending', 'queued', 'extracting', 'translating', 'writing')")) {
        return { rows: [] };
      }
      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub-1",
            user_id: "user-1",
            plan_type: "free",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: null,
            provider_subscription_id: null,
            current_period_start: null,
            current_period_end: null,
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes("FROM usage_ledgers")) {
        return {
          rows: [{
            slides_used: "0",
            docs_pages_used: "0",
            sheets_cells_used: "0",
            total_jobs: 0,
          }],
        };
      }
      if (sql.includes("FROM users u")) {
        return {
          rows: [{
            slides_balance: "0",
            docs_pages_balance: "0",
            sheets_cells_balance: "0",
            slides_refundable_units: "0",
          }],
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT 1 FROM translation_jobs")) {
          return { rows: [{ exists: 1 }], rowCount: 1 };
        }
        if (sql.includes("COUNT(*)::int AS n")) {
          throw new Error("global count should not run after same-user admission fails");
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    }),
  } as unknown as Pool;

  const redis = createRedisMock();
  const config: AppConfig = {
    port: 8080,
    nodeEnv: "test",
    gcpProjectId: "YOUR_GCP_PROJECT_ID",
    gcpRegion: "us-central1",
    db: {
      host: "localhost",
      port: 5432,
      name: "translay",
      user: "postgres",
      password: "postgres",
      poolMax: 20,
    },
    redis: {
      host: "localhost",
      port: 6379,
    },
    cloudTasks: {
      queueName: "YOUR_CLOUD_TASKS_QUEUE",
      location: "us-central1",
      workerUrl: "https://worker.example.com",
      audience: "https://worker.example.com/tasks/translate",
      invokerServiceAccount: "worker-invoker@example.com",
    },
    session: {
      secret: "x".repeat(32),
      cookieName: "__session",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    domain: "your-domain.example.com",
    publicAuth: {
      googleWebClientId: "",
      googleIdTokenAudiences: [],
    },
    billing: {
      providerName: "paddle",
      paddle: {
        environment: "sandbox",
        clientToken: "test_client_token",
        apiKey: "pdl_test_api_key",
        webhookSecret: "whsec_test_secret",
        priceIds: {
          pro_monthly: "pri_monthly_123",
          pro_yearly: "pri_yearly_456",
          credits_slides: "pri_credits_slide",
        },
        priceAmounts: {
          pro_monthly: 999,
          pro_yearly: 11999,
          credits_slides: 4,
        },
        creditSkus: {
          slides: {
            unit: "slides_pages",
            minUnits: 1,
            maxUnits: 100,
            priceId: "pri_credits_slide",
            amountCents: 4,
            minimumChargeAmountCents: 70,
          },
        },
        webhookToleranceSeconds: 300,
      },
    },
    entitlementCacheTtl: 300,
    jobs: {
      maxGlobalInFlightJobs: 50,
    },
    rateLimits: {
      global: { windowSeconds: 60, maxRequests: 1200 },
      userWrite: { windowSeconds: 60, maxRequests: 30 },
      userRead: { windowSeconds: 60, maxRequests: 120 },
    },
    security: {
      kmsKeyName: null,
      internalCronSecret: null,
    },
  };

  let statusCode = 200;
  let payload: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return this;
    },
  } as never;

  const req = {
    authContext: { user_id: "user-1" as UserId },
    headers: { authorization: "Bearer host-token" },
    body: {
      host_type: "slides",
      document_id: "source-doc",
      document_name: "Quarterly deck",
      source_language_mode: "auto",
      target_language_input: "French",
      output_mode: "append_in_file",
      range_mode: "custom",
      range_expression: "1",
      drive_access: {
        source_worker_permission_id: "source-permission",
      },
      idempotency_key: "idem-1",
    },
  } as never;

  await createJobHandler(pool, redis, config)(req, res);

  assert.equal(statusCode, 409);
  assert.deepEqual(payload, {
    error: "CONCURRENT_JOB_RUNNING",
    message: "A translation job is already in progress",
  });
});
