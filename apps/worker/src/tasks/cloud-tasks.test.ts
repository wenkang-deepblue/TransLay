import test from "node:test";
import assert from "node:assert/strict";
import {
  __buildStageTaskIdForTests,
  computeDelayedStageRetryScheduleTime,
} from "./cloud-tasks";

test("computeDelayedStageRetryScheduleTime falls back to 30s when lease expiry is missing", () => {
  const now = new Date("2026-04-16T10:00:00.000Z");
  assert.equal(
    computeDelayedStageRetryScheduleTime(null, now).toISOString(),
    "2026-04-16T10:00:30.000Z"
  );
});

test("computeDelayedStageRetryScheduleTime adds a 2s grace window after lease expiry", () => {
  const now = new Date("2026-04-16T10:00:00.000Z");
  const leaseExpiresAt = new Date("2026-04-16T10:05:00.000Z");
  assert.equal(
    computeDelayedStageRetryScheduleTime(leaseExpiresAt, now).toISOString(),
    "2026-04-16T10:05:02.000Z"
  );
});

test("stage task ids are deterministic per stage attempt and isolate lease retries", () => {
  assert.equal(
    __buildStageTaskIdForTests("job-1", "authority", 3),
    "job-1-authority-3"
  );
  assert.equal(
    __buildStageTaskIdForTests("job-1", "authority", 3, "lease-retry"),
    "job-1-authority-3-lease-retry"
  );
});
