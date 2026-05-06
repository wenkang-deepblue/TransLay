import test from "node:test";
import assert from "node:assert/strict";
import {
  __applyWriteResultToSlideResultsForTests,
  __buildSlideBillingSettlementForTests,
  __computeProviderRetryDelayMsForTests,
  __hasPartialDeliveryForTests,
  __resolveModelTargetLanguageForTests,
  __hasSlideExecutionWarningsForTests,
  __isRetryableProviderErrorForTests,
  __orderTranslatedNodesForWriteForTests,
  __selectSlidesReadyForMaterializationForTests,
  __selectSlidesReadyForWriteForTests,
  __shouldFinalizeAsPartialSuccessForTests,
  __attemptTerminalDriveCleanupForTests,
  __finalizeCanceledJobForTests,
  __finalizeFailedJobForTests,
  __finalizeSuccessfulJobForTests,
  __resetTerminalDriveCleanupHookForTests,
  __setTerminalDriveCleanupHookForTests,
  __summarizeSlideExecutionForTests,
  __toSafePipelineMessageForTests,
  __validateTargetLanguageOutputForTests,
} from "./job-pipeline";
import {
  initializeJobSlideResults,
  markSlideCanceledAfterTranslation,
  markSlideCommitted,
  markSlideExcludedUnsafe,
  markSlideFailure,
  markSlideTranslated,
} from "./slide-results";
import type { WriteBackResult } from "../adapters/slides";
import {
  __resetDrivePermissionsHooksForTests,
  __setDrivePermissionsHooksForTests,
} from "../adapters/drive/permissions";
import { DriveCleanupAuthError } from "../adapters/drive/auth";

test("selectSlidesReadyForMaterialization skips excluded and failed slides", () => {
  const slideResults = initializeJobSlideResults([1, 2, 3, 4]);
  markSlideExcludedUnsafe(slideResults, 2);
  markSlideFailure(slideResults, 3, "authority", "LLM_PROVIDER_ERROR");
  markSlideTranslated(slideResults, 4);

  const slides = [
    { slide_index: 1 },
    { slide_index: 2 },
    { slide_index: 3 },
    { slide_index: 4 },
  ];

  assert.deepEqual(
    __selectSlidesReadyForMaterializationForTests(slides, slideResults).map(
      (slide) => slide.slide_index
    ),
    [1, 4]
  );
});

test("selectSlidesReadyForWrite keeps only translated slides", () => {
  const slideResults = initializeJobSlideResults([1, 2, 3]);
  markSlideTranslated(slideResults, 1);
  markSlideFailure(slideResults, 2, "materialization", "LLM_PROVIDER_ERROR");
  markSlideCommitted(slideResults, 1);

  const slides = [{ slide_index: 1 }, { slide_index: 2 }, { slide_index: 3 }];

  assert.deepEqual(
    __selectSlidesReadyForWriteForTests(slides, slideResults).map(
      (slide) => slide.slide_index
    ),
    []
  );
});

test("hasSlideExecutionWarnings detects skipped and excluded slides", () => {
  const slideResults = initializeJobSlideResults([1, 2, 3]);
  markSlideTranslated(slideResults, 1);
  markSlideFailure(slideResults, 2, "materialization", "LLM_PROVIDER_ERROR");
  markSlideExcludedUnsafe(slideResults, 3);

  assert.equal(__hasSlideExecutionWarningsForTests(slideResults), true);
  assert.deepEqual(__summarizeSlideExecutionForTests(slideResults), {
    committed_slides: 0,
    skipped_slides: 1,
    excluded_slides: 1,
  });
});

test("applyWriteResultToSlideResults marks committed and failed write slides explicitly", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideTranslated(slideResults, 1);
  markSlideTranslated(slideResults, 2);

  const writeResult: WriteBackResult = {
    outputUrl: "https://docs.google.com/presentation/d/test/edit",
    committedUnits: 1,
    committed_slide_indexes: [1],
    failed_slide_indexes: [2],
    slide_results: [
      {
        slide_index: 1,
        status: "committed",
        warning_codes: [],
      },
      {
        slide_index: 2,
        status: "skipped_write_failed",
        warning_codes: [],
        error_code: "HOST_ADAPTER_ERROR",
      },
    ],
    warnings: [],
  };

  __applyWriteResultToSlideResultsForTests(slideResults, writeResult);

  assert.deepEqual(__summarizeSlideExecutionForTests(slideResults), {
    committed_slides: 1,
    skipped_slides: 1,
    excluded_slides: 0,
  });
});

test("billing settlement refunds undelivered slides after successful job completion", () => {
  const slideResults = initializeJobSlideResults([1, 2, 3]);
  markSlideTranslated(slideResults, 1);
  markSlideCommitted(slideResults, 1);
  markSlideTranslated(slideResults, 2);
  markSlideFailure(slideResults, 2, "write", "HOST_ADAPTER_ERROR");
  markSlideExcludedUnsafe(slideResults, 3);

  assert.deepEqual(__buildSlideBillingSettlementForTests(slideResults, "successful"), {
    provisionally_billed_units: 2,
    gross_billed_slides: 2,
    refunded_slides: 1,
    net_billed_slides: 1,
    provisional_slide_indices: [1, 2],
    refunded_slide_indices: [2],
    provisional_units_by_slide: new Map([
      [1, 1],
      [2, 1],
    ]),
    refunded_units_by_slide: new Map([[2, 1]]),
  });
});

test("billing settlement keeps provisionally billed slides on user cancellation", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideTranslated(slideResults, 1);
  markSlideCommitted(slideResults, 1);
  markSlideTranslated(slideResults, 2);
  markSlideCanceledAfterTranslation(slideResults, 2);

  assert.deepEqual(__buildSlideBillingSettlementForTests(slideResults, "canceled"), {
    provisionally_billed_units: 2,
    gross_billed_slides: 2,
    refunded_slides: 0,
    net_billed_slides: 2,
    provisional_slide_indices: [1, 2],
    refunded_slide_indices: [],
    provisional_units_by_slide: new Map([
      [1, 1],
      [2, 1],
    ]),
    refunded_units_by_slide: new Map(),
  });
});

test("billing settlement refunds provisional slides on terminal failure", () => {
  const slideResults = initializeJobSlideResults([4, 5]);
  markSlideTranslated(slideResults, 4);
  markSlideTranslated(slideResults, 5);
  markSlideCommitted(slideResults, 5);

  assert.deepEqual(__buildSlideBillingSettlementForTests(slideResults, "failed"), {
    provisionally_billed_units: 2,
    gross_billed_slides: 2,
    refunded_slides: 1,
    net_billed_slides: 1,
    provisional_slide_indices: [4, 5],
    refunded_slide_indices: [4],
    provisional_units_by_slide: new Map([
      [4, 1],
      [5, 1],
    ]),
    refunded_units_by_slide: new Map([[4, 1]]),
  });
});

test("write stage preserves available translated nodes when some nodes are missing", () => {
  const ordered = __orderTranslatedNodesForWriteForTests(
    [{ node_id: "n1" }, { node_id: "n2" }, { node_id: "n3" }],
    [
      {
        node_id: "n1",
        translated_full_text: "uno",
        paragraphs: [
          {
            paragraph_id: "p0",
            translated_text: "uno",
            bullet_behavior: "none",
          },
        ],
        segments: [
          {
            segment_id: "p0_r0",
            translated_text: "uno",
            style_role: "default",
          },
        ],
      },
      {
        node_id: "n3",
        translated_full_text: "tres",
        paragraphs: [
          {
            paragraph_id: "p0",
            translated_text: "tres",
            bullet_behavior: "none",
          },
        ],
        segments: [
          {
            segment_id: "p0_r0",
            translated_text: "tres",
            style_role: "default",
          },
        ],
      },
    ]
  );

  assert.deepEqual(
    ordered.map((node) => node.node_id),
    ["n1", "n3"]
  );
});

test("worker resolves preset target language to a natural-language label for model prompts", () => {
  assert.equal(__resolveModelTargetLanguageForTests("Greek"), "Greek");
  assert.equal(__resolveModelTargetLanguageForTests("EL"), "Greek");
  assert.equal(__resolveModelTargetLanguageForTests("Tibetan"), "Tibetan");
});

test("target-language validation flags obvious Greek-to-English mismatches", () => {
  assert.deepEqual(
    __validateTargetLanguageOutputForTests("Greek", [
      "Hello team, this slide stayed in English instead of the requested language.",
    ]),
    {
      ok: false,
      checked: true,
      reason: "Translated output does not appear to be in Greek.",
    }
  );
});

test("target-language validation does not block valid Greek script output", () => {
  assert.deepEqual(
    __validateTargetLanguageOutputForTests("Greek", [
      "Γεια σας ομάδα, αυτή η διαφάνεια μεταφράστηκε σωστά στα ελληνικά.",
    ]),
    {
      ok: true,
      checked: true,
    }
  );
});

test("provider retry delays use exponential backoff with jitter", () => {
  assert.equal(__computeProviderRetryDelayMsForTests(1, 0), 350);
  assert.equal(__computeProviderRetryDelayMsForTests(1, 1), 650);
  assert.equal(__computeProviderRetryDelayMsForTests(2, 0.5), 1000);
  assert.equal(__computeProviderRetryDelayMsForTests(3, 0.5), 2000);
  assert.equal(__computeProviderRetryDelayMsForTests(4, 1), 2600);
});

test("provider retry loop does not retry Vertex quota exhausted errors", () => {
  const error = Object.assign(new Error("vertex quota exhausted"), {
    code: "VERTEX_QUOTA_EXHAUSTED",
    status: 429,
  });

  assert.equal(__isRetryableProviderErrorForTests(error), false);
});

test("safe pipeline message surfaces quota exhausted codes from non-pipeline errors", () => {
  const slidesQuotaError = Object.assign(new Error("slides quota exhausted"), {
    code: "SLIDES_QUOTA_EXHAUSTED",
  });
  const vertexQuotaError = Object.assign(new Error("vertex quota exhausted"), {
    code: "VERTEX_QUOTA_EXHAUSTED",
  });

  assert.equal(
    __toSafePipelineMessageForTests(slidesQuotaError, "fallback"),
    "Google Slides™ API quota was temporarily exhausted. Please retry shortly."
  );
  assert.equal(
    __toSafePipelineMessageForTests(vertexQuotaError, "fallback"),
    "Vertex AI quota was temporarily exhausted. Please retry shortly."
  );
});

test("partial delivery detects notes-only and body-partial outputs", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideCommitted(slideResults, 1);
  slideResults.set(1, {
    ...slideResults.get(1)!,
    output_visible: true,
    notes_present: true,
    content_output_visible: false,
    notes_output_visible: true,
    body_failed_node_count: 0,
  });

  markSlideCommitted(slideResults, 2);
  slideResults.set(2, {
    ...slideResults.get(2)!,
    output_visible: true,
    notes_present: false,
    content_output_visible: true,
    notes_output_visible: false,
    body_failed_node_count: 1,
  });

  assert.equal(__hasPartialDeliveryForTests(slideResults), true);
});

test("quota exhausted finalizes as partial success only after visible delivery exists", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideCommitted(slideResults, 1);
  slideResults.set(1, {
    ...slideResults.get(1)!,
    output_visible: true,
    content_output_visible: true,
    notes_output_visible: false,
  });

  assert.equal(
    __shouldFinalizeAsPartialSuccessForTests("VERTEX_QUOTA_EXHAUSTED", slideResults),
    true
  );
  assert.equal(
    __shouldFinalizeAsPartialSuccessForTests("SLIDES_QUOTA_EXHAUSTED", initializeJobSlideResults([1])),
    false
  );
});

test("terminal drive cleanup returns a failed status update without changing job terminal outcome", async () => {
  __setDrivePermissionsHooksForTests({
    getDriveClientForJob: async () => {
      throw new DriveCleanupAuthError(
        "host_oauth_token_expired",
        "Host OAuth token is expired for Drive cleanup"
      );
    },
  });

  try {
    const update = await __attemptTerminalDriveCleanupForTests(
      {} as never,
      createTerminalCleanupJob(),
      "job-terminal-cleanup"
    );

    assert.deepEqual(update, {
      driveCleanupStatus: "failed",
      driveCleanupLastErrorCode: "host_oauth_token_expired",
      incrementDriveCleanupAttempts: true,
    });
  } finally {
    __resetDrivePermissionsHooksForTests();
  }
});

test("terminal drive cleanup converts unexpected cleanup errors into failed cleanup metadata", async () => {
  __setTerminalDriveCleanupHookForTests(async () => {
    throw new Error("unexpected drive client construction failure");
  });

  try {
    const update = await __attemptTerminalDriveCleanupForTests(
      {} as never,
      createTerminalCleanupJob(),
      "job-terminal-cleanup"
    );

    assert.deepEqual(update, {
      driveCleanupStatus: "failed",
      driveCleanupLastErrorCode: "drive_cleanup_unexpected_error",
      incrementDriveCleanupAttempts: true,
    });
  } finally {
    __resetTerminalDriveCleanupHookForTests();
  }
});

test("terminal drive cleanup is idempotent after a succeeded cleanup", async () => {
  __setTerminalDriveCleanupHookForTests(async () => {
    throw new Error("cleanup should not rerun for succeeded rows");
  });

  try {
    const update = await __attemptTerminalDriveCleanupForTests(
      {} as never,
      createTerminalCleanupJob({
        drive_cleanup_status: "succeeded",
      }),
      "job-terminal-cleanup"
    );

    assert.deepEqual(update, {});
  } finally {
    __resetTerminalDriveCleanupHookForTests();
  }
});

test("terminal drive cleanup marks stale no-permission rows as not required", async () => {
  const update = await __attemptTerminalDriveCleanupForTests(
    {} as never,
    createTerminalCleanupJob({
      source_worker_permission_id: null,
      target_worker_permission_id: null,
      drive_cleanup_status: "pending",
    }),
    "job-terminal-cleanup"
  );

  assert.deepEqual(update, {
    driveCleanupStatus: "not_required",
    driveCleanupLastErrorCode: null,
  });
});

test("terminal finalizers run drive cleanup before terminal token purge SQL", async () => {
  const cases = [
    {
      name: "successful",
      finalize: __finalizeSuccessfulJobForTests,
      terminalStatus: "completed",
    },
    {
      name: "canceled",
      finalize: __finalizeCanceledJobForTests,
      terminalStatus: "canceled",
    },
    {
      name: "failed",
      finalize: __finalizeFailedJobForTests,
      terminalStatus: "failed",
    },
  ] as const;

  for (const testCase of cases) {
    const events: string[] = [];
    __setTerminalDriveCleanupHookForTests(async () => {
      events.push(`${testCase.name}:cleanup`);
      return {
        status: "succeeded",
        attempted: true,
        errorCode: null,
        targetCount: 1,
      };
    });

    try {
      const pool = createFinalizePool(events, testCase.name);
      const redis = createRedisMock();
      await testCase.finalize(
        pool as never,
        redis as never,
        createTerminalCleanupJob({ id: `${testCase.name}-job` as never }),
        `${testCase.name}-job`,
        createEmptyWriteResult(),
        initializeJobSlideResults([])
      );

      const cleanupIndex = events.indexOf(`${testCase.name}:cleanup`);
      const terminalUpdateIndex = events.findIndex((event) =>
        event.startsWith(`${testCase.name}:terminal-update:`)
      );
      assert.equal(cleanupIndex, 0);
      assert.equal(terminalUpdateIndex > cleanupIndex, true);
      assert.ok(
        events[terminalUpdateIndex]!.includes(`:${testCase.terminalStatus}:`),
        `${testCase.name} terminal update should use ${testCase.terminalStatus}`
      );
      assert.match(events[terminalUpdateIndex]!, /host_oauth_access_token_enc = NULL/);
      assert.match(events[terminalUpdateIndex]!, /drive_cleanup_attempts = drive_cleanup_attempts \+ 1/);
    } finally {
      __resetTerminalDriveCleanupHookForTests();
    }
  }
});

function createTerminalCleanupJob(
  overrides: Partial<Parameters<typeof __attemptTerminalDriveCleanupForTests>[1]> = {}
): Parameters<typeof __attemptTerminalDriveCleanupForTests>[1] {
  return {
    id: "job-terminal-cleanup",
    user_id: "user-1",
    source_doc_id: "source-doc",
    target_doc_id: null,
    source_worker_permission_id: "source-permission",
    target_worker_permission_id: null,
    drive_cleanup_status: "pending",
    ...overrides,
  } as Parameters<typeof __attemptTerminalDriveCleanupForTests>[1];
}

function createEmptyWriteResult(): WriteBackResult {
  return {
    outputUrl: "https://docs.google.com/presentation/d/output/edit",
    committedUnits: 0,
    committed_slide_indexes: [],
    failed_slide_indexes: [],
    slide_results: [],
    warnings: [],
  };
}

function createFinalizePool(events: string[], name: string) {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE translation_jobs")) {
        events.push(`${name}:terminal-update:${String(params?.[1])}:${sql}`);
      } else {
        events.push(`${name}:sql:${sql}`);
      }
      return { rows: [] };
    },
    release() {
      events.push(`${name}:release`);
    },
  };
  return {
    connect: async () => client,
  };
}

function createRedisMock() {
  return {
    pipeline() {
      return {
        hset() {
          return this;
        },
        expire() {
          return this;
        },
        exec: async () => [],
      };
    },
    del: async () => 1,
  };
}
