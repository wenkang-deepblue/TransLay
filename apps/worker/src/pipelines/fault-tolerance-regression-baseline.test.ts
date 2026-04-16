import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE4B_REQUIRED_SCENARIO_IDS,
  PHASE4B_REQUIRED_TERMINAL_STATUSES,
  PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS,
  evaluatePhase4BFaultToleranceRegressionBaseline,
} from "./fault-tolerance-regression-baseline";

test("phase 4B.7 regression baseline covers all required scenario ids and terminal statuses", () => {
  const scenarioIds = new Set(
    PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS.map((scenario) => scenario.scenario_id)
  );
  const terminalStatuses = new Set(
    PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS.map((scenario) => scenario.expected_terminal_status)
  );

  assert.deepEqual(
    [...scenarioIds].sort(),
    [...PHASE4B_REQUIRED_SCENARIO_IDS].sort()
  );
  assert.deepEqual(
    [...terminalStatuses].sort(),
    [...PHASE4B_REQUIRED_TERMINAL_STATUSES].sort()
  );
});

test("phase 4B.7 regression baseline meets fault-tolerance acceptance thresholds", () => {
  const baseline = evaluatePhase4BFaultToleranceRegressionBaseline(
    PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS
  );

  assert.equal(baseline.scenario_count, PHASE4B_REQUIRED_SCENARIO_IDS.length);
  assert.equal(baseline.status_expectation_pass_rate, 1);
  assert.equal(baseline.skipped_visibility_pass_rate, 1);
  assert.equal(baseline.refund_expectation_pass_rate, 1);
  assert.equal(baseline.net_billing_alignment_pass_rate, 1);
  assert.equal(baseline.committed_visibility_pass_rate, 1);
  assert.equal(baseline.unsafe_excluded_unbilled_pass_rate, 1);
  assert.ok(
    baseline.completed_with_warnings_case_count >= 4,
    `completed_with_warnings_case_count=${baseline.completed_with_warnings_case_count}`
  );
  assert.ok(
    baseline.failed_case_count >= 1,
    `failed_case_count=${baseline.failed_case_count}`
  );
});

test("phase 4B.7 30-slide tail failure sample preserves first 29 slides and refunds only the failed tail slide", () => {
  const baseline = evaluatePhase4BFaultToleranceRegressionBaseline(
    PHASE4B_FAULT_TOLERANCE_REGRESSION_SCENARIOS
  );
  const tailFailure = baseline.scenario_results.find(
    (scenario) => scenario.scenario_id === "tail_slide_failure_30_pages"
  );
  assert.ok(tailFailure);

  assert.equal(tailFailure.actual_terminal_status, "completed_with_warnings");
  assert.equal(tailFailure.actual_successful_slide_indices.length, 29);
  assert.deepEqual(tailFailure.actual_skipped_slide_indices, [30]);
  assert.deepEqual(tailFailure.actual_refunded_slide_indices, [30]);
  assert.equal(tailFailure.actual_net_billed_slides, 29);
});
