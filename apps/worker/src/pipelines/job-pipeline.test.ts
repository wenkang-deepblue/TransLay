import test from "node:test";
import assert from "node:assert/strict";
import {
  __applyWriteResultToSlideResultsForTests,
  __hasSlideExecutionWarningsForTests,
  __selectSlidesReadyForMaterializationForTests,
  __selectSlidesReadyForWriteForTests,
  __summarizeSlideExecutionForTests,
} from "./job-pipeline";
import {
  initializeJobSlideResults,
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
