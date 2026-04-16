import test from "node:test";
import assert from "node:assert/strict";
import {
  __applyWriteResultToSlideResultsForTests,
  __buildSlideBillingSettlementForTests,
  __computeProviderRetryDelayMsForTests,
  __hasSlideExecutionWarningsForTests,
  __orderTranslatedNodesForWriteForTests,
  __selectSlidesReadyForMaterializationForTests,
  __selectSlidesReadyForWriteForTests,
  __summarizeSlideExecutionForTests,
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

test("provider retry delays use exponential backoff with jitter", () => {
  assert.equal(__computeProviderRetryDelayMsForTests(1, 0), 350);
  assert.equal(__computeProviderRetryDelayMsForTests(1, 1), 650);
  assert.equal(__computeProviderRetryDelayMsForTests(2, 0.5), 1000);
  assert.equal(__computeProviderRetryDelayMsForTests(3, 0.5), 2000);
  assert.equal(__computeProviderRetryDelayMsForTests(4, 1), 2600);
});
