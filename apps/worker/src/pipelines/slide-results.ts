import type {
  JobSlideResult,
  SlideFailureStage,
  SlideExecutionStatus,
} from "@translay/shared-contracts";

export type JobSlideResultMap = Map<number, JobSlideResult>;

type SlideFailureStatus = Extract<
  SlideExecutionStatus,
  | "skipped_translation_failed"
  | "skipped_materialization_failed"
  | "skipped_write_failed"
>;

const FAILURE_STATUS_BY_STAGE: Record<SlideFailureStage, SlideFailureStatus> = {
  extract: "skipped_translation_failed",
  authority: "skipped_translation_failed",
  materialization: "skipped_materialization_failed",
  write: "skipped_write_failed",
};

export function initializeJobSlideResults(
  slideIndices: readonly number[]
): JobSlideResultMap {
  const results: JobSlideResultMap = new Map();

  for (const slideIndex of [...new Set(slideIndices)].sort((left, right) => left - right)) {
    results.set(slideIndex, createPendingSlideResult(slideIndex));
  }

  return results;
}

export function markSlideExcludedUnsafe(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => ({
    ...current,
    status: "excluded_unsafe",
    warning_codes: appendUniqueCode(current.warning_codes, "unsafe_slide_excluded"),
  }));
}

export function markSlideTranslated(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (
      current.status === "excluded_unsafe" ||
      current.status === "committed" ||
      current.status === "skipped_translation_failed" ||
      current.status === "skipped_materialization_failed" ||
      current.status === "skipped_write_failed"
    ) {
      return current;
    }

    return {
      ...current,
      status: "translated",
      failure_stage: undefined,
      failure_reason_code: undefined,
      provisionally_billed: true,
      final_billable: false,
      refund_required: false,
      output_visible: false,
    };
  });
}

export function markSlideCommitted(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => ({
    ...current,
    status: "committed",
    failure_stage: undefined,
    failure_reason_code: undefined,
    final_billable: true,
    refund_required: false,
    output_visible: true,
  }));
}

export function markSlideFailure(
  slideResults: JobSlideResultMap,
  slideIndex: number,
  failureStage: SlideFailureStage,
  failureReasonCode: string
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (current.status === "committed") {
      return current;
    }

    if (current.status === "excluded_unsafe") {
      return current;
    }

    return {
      ...current,
      status: FAILURE_STATUS_BY_STAGE[failureStage],
      failure_stage: failureStage,
      failure_reason_code: failureReasonCode,
      final_billable: false,
      refund_required: current.provisionally_billed,
      output_visible: false,
    };
  });
}

export function markSlideCanceledAfterTranslation(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (!current.provisionally_billed || current.output_visible) {
      return current;
    }

    return {
      ...current,
      status: "canceled_after_translation",
      failure_stage: undefined,
      failure_reason_code: undefined,
      final_billable: false,
      // Phase 4B freeze: user-driven cancellation after provisional billing
      // keeps the charge to resist prompt-injection/token-burn abuse.
      refund_required: false,
      output_visible: false,
    };
  });
}

export function listJobSlideResults(
  slideResults: JobSlideResultMap
): JobSlideResult[] {
  return [...slideResults.values()].sort((left, right) => left.slide_index - right.slide_index);
}

function createPendingSlideResult(slideIndex: number): JobSlideResult {
  return {
    slide_index: slideIndex,
    status: "pending",
    warning_codes: [],
    provisionally_billed: false,
    final_billable: false,
    refund_required: false,
    output_visible: false,
  };
}

function updateSlideResult(
  slideResults: JobSlideResultMap,
  slideIndex: number,
  updater: (current: JobSlideResult) => JobSlideResult
): void {
  const current = slideResults.get(slideIndex);
  if (!current) {
    return;
  }

  slideResults.set(slideIndex, updater(current));
}

function appendUniqueCode(
  warningCodes: readonly string[],
  code: string
): readonly string[] {
  if (warningCodes.includes(code)) {
    return warningCodes;
  }

  return [...warningCodes, code];
}
