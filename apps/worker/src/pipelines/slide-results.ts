import type {
  JobSlideResult,
  SlideFailureStage,
  SlideExecutionStatus,
} from "@translay/shared-contracts";
import type { SlideExtractionResult } from "../adapters/slides";

export type JobSlideResultMap = Map<number, JobSlideResult>;
type SlideInitializationInput = number | SlideExtractionResult;

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

const HALF_SLIDE_BILLING_UNIT = 0.5;
const FULL_SLIDE_BILLING_UNIT = 1;

export function initializeJobSlideResults(
  slideInputs: readonly SlideInitializationInput[],
  options?: {
    readonly notesPresentSlideIndices?: readonly number[];
  }
): JobSlideResultMap {
  const results: JobSlideResultMap = new Map();
  const notesPresent = new Set(options?.notesPresentSlideIndices ?? []);

  const normalizedSlides = slideInputs
    .map((slideInput) =>
      typeof slideInput === "number"
        ? {
            slide_index: slideInput,
            slide_object_id: undefined,
            slide_fingerprint: undefined,
            body_node_count: 0,
            notes_node_count: 0,
          }
        : {
            slide_index: slideInput.slide_index,
            slide_object_id: slideInput.slide_object_id,
            slide_fingerprint: slideInput.slide_fingerprint,
            body_node_count: slideInput.nodes.filter(
              (node) => node.element_type !== "speaker_notes"
            ).length,
            notes_node_count: slideInput.nodes.filter(
              (node) => node.element_type === "speaker_notes"
            ).length,
          }
    )
    .sort((left, right) => left.slide_index - right.slide_index);

  for (const slide of normalizedSlides) {
    results.set(
      slide.slide_index,
      createPendingSlideResult(
        slide.slide_index,
        slide.notes_node_count > 0 || notesPresent.has(slide.slide_index),
        slide.slide_object_id,
        slide.slide_fingerprint,
        slide.body_node_count,
        slide.notes_node_count
      )
    );
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
      current.status === "translated" ||
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
      content_translated: true,
      provisionally_billed: true,
      final_billable: false,
      refund_required: false,
      refunded: false,
      output_visible: false,
      provisional_billed_units: roundBillingUnits(
        (current.provisional_billed_units ?? 0) +
          (current.notes_present ? HALF_SLIDE_BILLING_UNIT : FULL_SLIDE_BILLING_UNIT)
      ),
    };
  });
}

export function markNotesTranslated(
  slideResults: JobSlideResultMap,
  slideIndex: number,
  notesTruncated: boolean
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (!current.notes_present || current.notes_translated) {
      return current;
    }

    return {
      ...current,
      notes_translated: true,
      notes_truncated: current.notes_truncated || notesTruncated,
      provisionally_billed: true,
      provisional_billed_units: roundBillingUnits(
        (current.provisional_billed_units ?? 0) + HALF_SLIDE_BILLING_UNIT
      ),
      refund_required: false,
    };
  });
}

export function markSlideCommitted(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    const partialContentOnly = current.notes_present && !current.notes_output_visible;
    return {
      ...current,
      status: "committed",
      failure_stage: undefined,
      failure_reason_code: undefined,
      final_billable: true,
      refund_required: false,
      refunded: false,
      output_visible: true,
      content_output_visible: true,
      final_billed_units: partialContentOnly ? HALF_SLIDE_BILLING_UNIT : FULL_SLIDE_BILLING_UNIT,
      warning_codes: reconcilePartialWarningCodes(
        current.warning_codes,
        partialContentOnly ? "slide_partial_content_only" : null
      ),
    };
  });
}

export function markNotesCommitted(
  slideResults: JobSlideResultMap,
  slideIndex: number
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (!current.notes_present) {
      return current;
    }

    const partialNotesOnly = !current.content_output_visible;
    return {
      ...current,
      status: "committed",
      final_billable: true,
      refund_required: false,
      refunded: false,
      output_visible: true,
      notes_output_visible: true,
      final_billed_units: partialNotesOnly ? HALF_SLIDE_BILLING_UNIT : FULL_SLIDE_BILLING_UNIT,
      warning_codes: reconcilePartialWarningCodes(
        current.warning_codes,
        partialNotesOnly ? "slide_partial_notes_only" : null
      ),
    };
  });
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

    if (current.notes_output_visible) {
      return {
        ...current,
        status: "committed",
        failure_stage: undefined,
        failure_reason_code: undefined,
        final_billable: true,
        refund_required: false,
        refunded: false,
        output_visible: true,
        content_output_visible: false,
        final_billed_units: HALF_SLIDE_BILLING_UNIT,
        warning_codes: reconcilePartialWarningCodes(current.warning_codes, "slide_partial_notes_only"),
      };
    }

    return {
      ...current,
      status: FAILURE_STATUS_BY_STAGE[failureStage],
      failure_stage: failureStage,
      failure_reason_code: failureReasonCode,
      final_billable: false,
      refund_required: (current.provisional_billed_units ?? 0) > 0,
      refunded: false,
      output_visible: false,
      content_output_visible: false,
      final_billed_units: 0,
    };
  });
}

export function markNotesFailure(
  slideResults: JobSlideResultMap,
  slideIndex: number,
  warningCode: "slide_notes_translation_failed" | "slide_notes_write_failed"
): void {
  updateSlideResult(slideResults, slideIndex, (current) => {
    if (!current.notes_present) {
      return current;
    }

    if (current.content_output_visible) {
      return {
        ...current,
        status: "committed",
        final_billable: true,
        refund_required: false,
        refunded: false,
        output_visible: true,
        notes_output_visible: false,
        final_billed_units: HALF_SLIDE_BILLING_UNIT,
        warning_codes: appendUniqueCode(
          reconcilePartialWarningCodes(current.warning_codes, "slide_partial_content_only"),
          warningCode
        ),
      };
    }

    return {
      ...current,
      warning_codes: appendUniqueCode(current.warning_codes, warningCode),
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
      refunded: false,
      output_visible: false,
      final_billed_units: 0,
    };
  });
}

export function listJobSlideResults(
  slideResults: JobSlideResultMap
): JobSlideResult[] {
  return [...slideResults.values()].sort((left, right) => left.slide_index - right.slide_index);
}

function createPendingSlideResult(
  slideIndex: number,
  notesPresent: boolean,
  sourceSlideObjectId?: string,
  sourceSlideFingerprint?: string,
  bodyNodeCount = 0,
  notesNodeCount = 0
): JobSlideResult {
  return {
    slide_index: slideIndex,
    source_slide_object_id: sourceSlideObjectId,
    source_slide_fingerprint: sourceSlideFingerprint,
    status: "pending",
    warning_codes: [],
    notes_present: notesPresent,
    content_translated: false,
    notes_translated: false,
    provisionally_billed: false,
    final_billable: false,
    refund_required: false,
    refunded: false,
    output_visible: false,
    content_output_visible: false,
    notes_output_visible: false,
    notes_truncated: false,
    body_node_count: bodyNodeCount,
    notes_node_count: notesNodeCount,
    body_translated_node_count: 0,
    notes_translated_node_count: 0,
    body_failed_node_count: 0,
    notes_failed_node_count: 0,
    body_written_node_count: 0,
    notes_written_node_count: 0,
    provisional_billed_units: 0,
    final_billed_units: 0,
    refunded_units: 0,
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

function removeWarningCode(
  warningCodes: readonly string[],
  code: string
): readonly string[] {
  return warningCodes.filter((entry) => entry !== code);
}

function reconcilePartialWarningCodes(
  warningCodes: readonly string[],
  keep: "slide_partial_content_only" | "slide_partial_notes_only" | null
): readonly string[] {
  let next = removeWarningCode(removeWarningCode(warningCodes, "slide_partial_content_only"), "slide_partial_notes_only");
  if (keep) {
    next = appendUniqueCode(next, keep);
  }
  return next;
}

function roundBillingUnits(value: number | undefined): number {
  return Math.round((value ?? 0) * 10) / 10;
}
