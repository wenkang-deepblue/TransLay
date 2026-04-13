import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWriteCommitOrder,
  getNextUncommittedWriteSlideIndex,
  initializeJobSlideResults,
  listJobSlideResults,
  markCommittedSlidesThroughCount,
  markSlideCanceledAfterTranslation,
  markSlideExcludedUnsafe,
  markSlideFailure,
  markSlideTranslated,
} from "./slide-results";

test("initializeJobSlideResults deduplicates and sorts slide indices", () => {
  const slideResults = initializeJobSlideResults([4, 2, 4, 1]);

  assert.deepEqual(
    listJobSlideResults(slideResults).map((slide) => [slide.slide_index, slide.status]),
    [
      [1, "pending"],
      [2, "pending"],
      [4, "pending"],
    ]
  );
});

test("initializeJobSlideResults returns an empty map for empty input", () => {
  const slideResults = initializeJobSlideResults([]);
  assert.deepEqual(listJobSlideResults(slideResults), []);
});

test("translated slide that later fails materialization becomes refundable", () => {
  const slideResults = initializeJobSlideResults([3]);

  markSlideTranslated(slideResults, 3);
  markSlideFailure(slideResults, 3, "materialization", "LLM_PROVIDER_ERROR");

  assert.deepEqual(listJobSlideResults(slideResults), [
    {
      slide_index: 3,
      status: "skipped_materialization_failed",
      failure_stage: "materialization",
      failure_reason_code: "LLM_PROVIDER_ERROR",
      warning_codes: [],
      provisionally_billed: true,
      final_billable: false,
      refund_required: true,
      output_visible: false,
    },
  ]);
});

test("excluded unsafe slide keeps exclusion status even if later failure is recorded", () => {
  const slideResults = initializeJobSlideResults([5]);

  markSlideExcludedUnsafe(slideResults, 5);
  markSlideFailure(slideResults, 5, "authority", "UNSAFE_LLM_INPUT");

  assert.deepEqual(listJobSlideResults(slideResults), [
    {
      slide_index: 5,
      status: "excluded_unsafe",
      warning_codes: ["unsafe_slide_excluded"],
      provisionally_billed: false,
      final_billable: false,
      refund_required: false,
      output_visible: false,
    },
  ]);
});

test("markSlideTranslated does not revive a previously failed slide", () => {
  const slideResults = initializeJobSlideResults([7]);

  markSlideFailure(slideResults, 7, "materialization", "LLM_PROVIDER_ERROR");
  markSlideTranslated(slideResults, 7);

  assert.deepEqual(listJobSlideResults(slideResults), [
    {
      slide_index: 7,
      status: "skipped_materialization_failed",
      failure_stage: "materialization",
      failure_reason_code: "LLM_PROVIDER_ERROR",
      warning_codes: [],
      provisionally_billed: false,
      final_billable: false,
      refund_required: false,
      output_visible: false,
    },
  ]);
});

test("markSlideTranslated is idempotent for an already translated slide", () => {
  const slideResults = initializeJobSlideResults([8]);

  markSlideTranslated(slideResults, 8);
  markSlideTranslated(slideResults, 8);

  assert.deepEqual(listJobSlideResults(slideResults), [
    {
      slide_index: 8,
      status: "translated",
      failure_stage: undefined,
      failure_reason_code: undefined,
      warning_codes: [],
      provisionally_billed: true,
      final_billable: false,
      refund_required: false,
      output_visible: false,
    },
  ]);
});

test("markCommittedSlidesThroughCount follows append write order", () => {
  const slideResults = initializeJobSlideResults([1, 3, 2]);
  for (const slideIndex of [1, 2, 3]) {
    markSlideTranslated(slideResults, slideIndex);
  }

  const writeCommitOrder = buildWriteCommitOrder("append_in_file", [
    { slide_index: 1 },
    { slide_index: 3 },
    { slide_index: 2 },
  ]);

  markCommittedSlidesThroughCount(slideResults, writeCommitOrder, 2);

  assert.deepEqual(writeCommitOrder, [3, 2, 1]);
  assert.deepEqual(
    listJobSlideResults(slideResults).map((slide) => [slide.slide_index, slide.status, slide.output_visible]),
    [
      [1, "translated", false],
      [2, "committed", true],
      [3, "committed", true],
    ]
  );
  assert.equal(getNextUncommittedWriteSlideIndex(slideResults, writeCommitOrder), 1);
});

test("buildWriteCommitOrder keeps original order for create_new_file", () => {
  const writeCommitOrder = buildWriteCommitOrder("create_new_file", [
    { slide_index: 4 },
    { slide_index: 1 },
    { slide_index: 9 },
  ]);

  assert.deepEqual(writeCommitOrder, [4, 1, 9]);
});

test("markSlideCanceledAfterTranslation only changes non-visible translated slides", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideTranslated(slideResults, 1);
  markSlideTranslated(slideResults, 2);

  const writeCommitOrder = buildWriteCommitOrder("create_new_file", [
    { slide_index: 1 },
    { slide_index: 2 },
  ]);
  markCommittedSlidesThroughCount(slideResults, writeCommitOrder, 1);
  markSlideCanceledAfterTranslation(slideResults, 1);
  markSlideCanceledAfterTranslation(slideResults, 2);

  assert.deepEqual(
    listJobSlideResults(slideResults).map((slide) => [slide.slide_index, slide.status]),
    [
      [1, "committed"],
      [2, "canceled_after_translation"],
    ]
  );
  assert.equal(listJobSlideResults(slideResults)[1]?.refund_required, false);
});

test("getNextUncommittedWriteSlideIndex returns null when all slides are committed", () => {
  const slideResults = initializeJobSlideResults([1, 2]);
  markSlideTranslated(slideResults, 1);
  markSlideTranslated(slideResults, 2);

  const writeCommitOrder = buildWriteCommitOrder("create_new_file", [
    { slide_index: 1 },
    { slide_index: 2 },
  ]);
  markCommittedSlidesThroughCount(slideResults, writeCommitOrder, 2);

  assert.equal(getNextUncommittedWriteSlideIndex(slideResults, writeCommitOrder), null);
});
