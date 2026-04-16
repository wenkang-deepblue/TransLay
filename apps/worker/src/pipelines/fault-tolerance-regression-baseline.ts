import {
  __buildSlideBillingSettlementForTests,
} from "./job-pipeline";
import {
  initializeJobSlideResults,
  listJobSlideResults,
  markSlideCanceledAfterTranslation,
  markSlideCommitted,
  markSlideExcludedUnsafe,
  markSlideFailure,
  markSlideTranslated,
} from "./slide-results";

type Phase4BTerminalStatus = "completed" | "completed_with_warnings" | "failed" | "canceled";
type Phase4BSettlementMode = "successful" | "failed" | "canceled";
type Phase4BOperation =
  | { kind: "translated"; slide_number: number }
  | { kind: "committed"; slide_number: number }
  | { kind: "excluded_unsafe"; slide_number: number }
  | {
      kind: "failed";
      slide_number: number;
      failure_stage: "extract" | "authority" | "materialization" | "write";
      failure_reason_code: string;
    }
  | { kind: "canceled_after_translation"; slide_number: number };

export interface Phase4BFaultToleranceRegressionScenario {
  readonly scenario_id: string;
  readonly description: string;
  readonly slide_count: number;
  readonly settlement_mode: Phase4BSettlementMode;
  readonly expected_terminal_status: Phase4BTerminalStatus;
  readonly operations: readonly Phase4BOperation[];
  readonly expected_successful_slide_indices: readonly number[];
  readonly expected_skipped_slide_indices: readonly number[];
  readonly expected_refunded_slide_indices: readonly number[];
  readonly expected_net_billed_slides: number;
}

export interface Phase4BFaultToleranceScenarioResult {
  readonly scenario_id: string;
  readonly actual_terminal_status: Phase4BTerminalStatus;
  readonly actual_successful_slide_indices: number[];
  readonly actual_skipped_slide_indices: number[];
  readonly actual_refunded_slide_indices: number[];
  readonly actual_net_billed_slides: number;
}

export interface Phase4BFaultToleranceRegressionMetrics {
  readonly scenario_count: number;
  readonly completed_with_warnings_case_count: number;
  readonly failed_case_count: number;
  readonly canceled_case_count: number;
  readonly status_expectation_pass_rate: number;
  readonly skipped_visibility_pass_rate: number;
  readonly refund_expectation_pass_rate: number;
  readonly net_billing_alignment_pass_rate: number;
  readonly committed_visibility_pass_rate: number;
  readonly unsafe_excluded_unbilled_pass_rate: number;
  readonly scenario_results: readonly Phase4BFaultToleranceScenarioResult[];
}

export const PHASE4B_REQUIRED_SCENARIO_IDS = [
  "single_node_materialization_failure",
  "batch_materialization_split_recovery",
  "single_slide_write_failure_continues",
  "tail_slide_failure_30_pages",
  "user_canceled_after_translation_keeps_charge",
  "system_write_failure_refunds_failed_slide",
  "unsafe_slide_excluded_unbilled",
  "all_slides_failed_terminal_failure",
] as const;

export const PHASE4B_REQUIRED_TERMINAL_STATUSES = [
  "completed_with_warnings",
  "failed",
  "canceled",
] as const satisfies readonly Phase4BTerminalStatus[];

export const PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS: readonly Phase4BFaultToleranceRegressionScenario[] = [
  {
    scenario_id: "single_node_materialization_failure",
    description: "single node materialization failure causes one slide skip while sibling slides still deliver",
    slide_count: 3,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      { kind: "translated", slide_number: 3 },
      { kind: "committed", slide_number: 1 },
      {
        kind: "failed",
        slide_number: 2,
        failure_stage: "materialization",
        failure_reason_code: "LLM_PROVIDER_ERROR",
      },
      { kind: "committed", slide_number: 3 },
    ],
    expected_successful_slide_indices: [1, 3],
    expected_skipped_slide_indices: [2],
    expected_refunded_slide_indices: [2],
    expected_net_billed_slides: 2,
  },
  {
    scenario_id: "batch_materialization_split_recovery",
    description: "batch materialization failure recovers most slides after single-node fallback",
    slide_count: 4,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      { kind: "translated", slide_number: 3 },
      { kind: "translated", slide_number: 4 },
      { kind: "committed", slide_number: 1 },
      { kind: "committed", slide_number: 2 },
      {
        kind: "failed",
        slide_number: 3,
        failure_stage: "materialization",
        failure_reason_code: "LLM_PROVIDER_ERROR",
      },
      { kind: "committed", slide_number: 4 },
    ],
    expected_successful_slide_indices: [1, 2, 4],
    expected_skipped_slide_indices: [3],
    expected_refunded_slide_indices: [3],
    expected_net_billed_slides: 3,
  },
  {
    scenario_id: "single_slide_write_failure_continues",
    description: "single slide writer failure should not stop later slides",
    slide_count: 5,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      { kind: "translated", slide_number: 3 },
      { kind: "translated", slide_number: 4 },
      { kind: "translated", slide_number: 5 },
      { kind: "committed", slide_number: 1 },
      { kind: "committed", slide_number: 2 },
      {
        kind: "failed",
        slide_number: 3,
        failure_stage: "write",
        failure_reason_code: "HOST_ADAPTER_ERROR",
      },
      { kind: "committed", slide_number: 4 },
      { kind: "committed", slide_number: 5 },
    ],
    expected_successful_slide_indices: [1, 2, 4, 5],
    expected_skipped_slide_indices: [3],
    expected_refunded_slide_indices: [3],
    expected_net_billed_slides: 4,
  },
  {
    scenario_id: "tail_slide_failure_30_pages",
    description: "30-page deck keeps first 29 delivered slides when the tail slide fails",
    slide_count: 30,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      ...range(1, 30).map((slide_number) => ({ kind: "translated", slide_number } as const)),
      ...range(1, 29).map((slide_number) => ({ kind: "committed", slide_number } as const)),
      {
        kind: "failed",
        slide_number: 30,
        failure_stage: "write" as const,
        failure_reason_code: "HOST_ADAPTER_ERROR",
      },
    ],
    expected_successful_slide_indices: range(1, 29),
    expected_skipped_slide_indices: [30],
    expected_refunded_slide_indices: [30],
    expected_net_billed_slides: 29,
  },
  {
    scenario_id: "user_canceled_after_translation_keeps_charge",
    description: "user cancellation after translation keeps already incurred charges",
    slide_count: 2,
    settlement_mode: "canceled",
    expected_terminal_status: "canceled",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      { kind: "committed", slide_number: 1 },
      { kind: "canceled_after_translation", slide_number: 2 },
    ],
    expected_successful_slide_indices: [1],
    expected_skipped_slide_indices: [],
    expected_refunded_slide_indices: [],
    expected_net_billed_slides: 2,
  },
  {
    scenario_id: "system_write_failure_refunds_failed_slide",
    description: "system write failure refunds the failed slide while keeping delivered output visible",
    slide_count: 2,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      { kind: "committed", slide_number: 1 },
      {
        kind: "failed",
        slide_number: 2,
        failure_stage: "write",
        failure_reason_code: "HOST_ADAPTER_ERROR",
      },
    ],
    expected_successful_slide_indices: [1],
    expected_skipped_slide_indices: [2],
    expected_refunded_slide_indices: [2],
    expected_net_billed_slides: 1,
  },
  {
    scenario_id: "unsafe_slide_excluded_unbilled",
    description: "unsafe excluded slides never become provisionally billed",
    slide_count: 2,
    settlement_mode: "successful",
    expected_terminal_status: "completed_with_warnings",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "committed", slide_number: 1 },
      { kind: "excluded_unsafe", slide_number: 2 },
    ],
    expected_successful_slide_indices: [1],
    expected_skipped_slide_indices: [2],
    expected_refunded_slide_indices: [],
    expected_net_billed_slides: 1,
  },
  {
    scenario_id: "all_slides_failed_terminal_failure",
    description: "all slides failing must converge to terminal failed status",
    slide_count: 3,
    settlement_mode: "failed",
    expected_terminal_status: "failed",
    operations: [
      { kind: "translated", slide_number: 1 },
      { kind: "translated", slide_number: 2 },
      {
        kind: "failed",
        slide_number: 1,
        failure_stage: "materialization",
        failure_reason_code: "LLM_PROVIDER_ERROR",
      },
      {
        kind: "failed",
        slide_number: 2,
        failure_stage: "write",
        failure_reason_code: "HOST_ADAPTER_ERROR",
      },
      {
        kind: "failed",
        slide_number: 3,
        failure_stage: "authority",
        failure_reason_code: "LLM_PROVIDER_ERROR",
      },
    ],
    expected_successful_slide_indices: [],
    expected_skipped_slide_indices: [1, 2, 3],
    expected_refunded_slide_indices: [1, 2],
    expected_net_billed_slides: 0,
  },
] as const;

export function evaluatePhase4BFaultToleranceRegressionBaseline(
  scenarios: readonly Phase4BFaultToleranceRegressionScenario[]
): Phase4BFaultToleranceRegressionMetrics {
  const scenarioResults: Phase4BFaultToleranceScenarioResult[] = [];
  let completedWithWarningsCaseCount = 0;
  let failedCaseCount = 0;
  let canceledCaseCount = 0;
  let statusPasses = 0;
  let skippedVisibilityPasses = 0;
  let refundPasses = 0;
  let netBillingPasses = 0;
  let committedVisibilityPasses = 0;
  let unsafeExcludedUnbilledPasses = 0;

  for (const scenario of scenarios) {
    const slideResults = initializeJobSlideResults(range(1, scenario.slide_count).map((slide) => slide - 1));
    applyScenarioOperations(slideResults, scenario.operations);

    const settlement = __buildSlideBillingSettlementForTests(
      slideResults,
      scenario.settlement_mode
    );
    const actual = deriveScenarioResult(slideResults, settlement, scenario.settlement_mode);
    scenarioResults.push({
      scenario_id: scenario.scenario_id,
      actual_terminal_status: actual.terminal_status,
      actual_successful_slide_indices: actual.successful_slide_indices,
      actual_skipped_slide_indices: actual.skipped_slide_indices,
      actual_refunded_slide_indices: actual.refunded_slide_indices,
      actual_net_billed_slides: settlement.net_billed_slides,
    });

    if (actual.terminal_status === "completed_with_warnings") {
      completedWithWarningsCaseCount += 1;
    } else if (actual.terminal_status === "failed") {
      failedCaseCount += 1;
    } else if (actual.terminal_status === "canceled") {
      canceledCaseCount += 1;
    }

    if (actual.terminal_status === scenario.expected_terminal_status) {
      statusPasses += 1;
    }
    if (sameNumberArray(actual.skipped_slide_indices, scenario.expected_skipped_slide_indices)) {
      skippedVisibilityPasses += 1;
    }
    if (sameNumberArray(actual.refunded_slide_indices, scenario.expected_refunded_slide_indices)) {
      refundPasses += 1;
    }
    if (settlement.net_billed_slides === scenario.expected_net_billed_slides) {
      netBillingPasses += 1;
    }
    if (sameNumberArray(actual.successful_slide_indices, scenario.expected_successful_slide_indices)) {
      committedVisibilityPasses += 1;
    }
    if (unsafeExcludedSlidesStayUnbilled(slideResults, settlement)) {
      unsafeExcludedUnbilledPasses += 1;
    }
  }

  return {
    scenario_count: scenarios.length,
    completed_with_warnings_case_count: completedWithWarningsCaseCount,
    failed_case_count: failedCaseCount,
    canceled_case_count: canceledCaseCount,
    status_expectation_pass_rate: rate(statusPasses, scenarios.length),
    skipped_visibility_pass_rate: rate(skippedVisibilityPasses, scenarios.length),
    refund_expectation_pass_rate: rate(refundPasses, scenarios.length),
    net_billing_alignment_pass_rate: rate(netBillingPasses, scenarios.length),
    committed_visibility_pass_rate: rate(committedVisibilityPasses, scenarios.length),
    unsafe_excluded_unbilled_pass_rate: rate(unsafeExcludedUnbilledPasses, scenarios.length),
    scenario_results: scenarioResults,
  };
}

function applyScenarioOperations(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  operations: readonly Phase4BOperation[]
): void {
  for (const operation of operations) {
    const slideIndex = operation.slide_number - 1;
    switch (operation.kind) {
      case "translated":
        markSlideTranslated(slideResults, slideIndex);
        break;
      case "committed":
        markSlideCommitted(slideResults, slideIndex);
        break;
      case "excluded_unsafe":
        markSlideExcludedUnsafe(slideResults, slideIndex);
        break;
      case "failed":
        markSlideFailure(
          slideResults,
          slideIndex,
          operation.failure_stage,
          operation.failure_reason_code
        );
        break;
      case "canceled_after_translation":
        markSlideCanceledAfterTranslation(slideResults, slideIndex);
        break;
    }
  }
}

function deriveScenarioResult(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  settlement: ReturnType<typeof __buildSlideBillingSettlementForTests>,
  mode: Phase4BSettlementMode
): {
  terminal_status: Phase4BTerminalStatus;
  successful_slide_indices: number[];
  skipped_slide_indices: number[];
  refunded_slide_indices: number[];
} {
  const successful = new Set<number>();
  const skipped = new Set<number>();
  const refunded = new Set(settlement.refunded_slide_indices.map((slideIndex) => slideIndex + 1));

  for (const slideResult of listJobSlideResults(slideResults)) {
    const slideNumber = slideResult.slide_index + 1;
    if (slideResult.output_visible) {
      successful.add(slideNumber);
      continue;
    }

    if (
      slideResult.status === "excluded_unsafe" ||
      slideResult.status === "skipped_translation_failed" ||
      slideResult.status === "skipped_materialization_failed" ||
      slideResult.status === "skipped_write_failed"
    ) {
      skipped.add(slideNumber);
    }
  }

  return {
    terminal_status: deriveTerminalStatus(
      successful.size,
      skipped.size,
      refunded.size,
      hasExcludedUnsafeSlides(slideResults),
      mode
    ),
    successful_slide_indices: [...successful].sort((left, right) => left - right),
    skipped_slide_indices: [...skipped].sort((left, right) => left - right),
    refunded_slide_indices: [...refunded].sort((left, right) => left - right),
  };
}

function deriveTerminalStatus(
  committedCount: number,
  skippedCount: number,
  refundedCount: number,
  hasExcludedUnsafe: boolean,
  mode: Phase4BSettlementMode
): Phase4BTerminalStatus {
  if (mode === "canceled") {
    return "canceled";
  }

  if (committedCount === 0) {
    return "failed";
  }

  if (skippedCount > 0 || refundedCount > 0 || hasExcludedUnsafe) {
    return "completed_with_warnings";
  }

  return "completed";
}

function hasExcludedUnsafeSlides(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return listJobSlideResults(slideResults).some(
    (slideResult) => slideResult.status === "excluded_unsafe"
  );
}

function unsafeExcludedSlidesStayUnbilled(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  settlement: ReturnType<typeof __buildSlideBillingSettlementForTests>
): boolean {
  const provisionallyBilled = new Set(settlement.provisional_slide_indices);
  return listJobSlideResults(slideResults)
    .filter((slideResult) => slideResult.status === "excluded_unsafe")
    .every((slideResult) => !provisionallyBilled.has(slideResult.slide_index));
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}
