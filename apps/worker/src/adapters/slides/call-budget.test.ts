import test from "node:test";
import assert from "node:assert/strict";
import {
  SlidesQuotaExhausted,
  createSlidesCallBudget,
  __resetSlidesCallBudgetForTests,
  __setSlidesBudgetSleepForTests,
} from "./call-budget";

test("Slides call budget honors Retry-After seconds before succeeding", async () => {
  __resetSlidesCallBudgetForTests();
  const recordedSleeps: number[] = [];
  __setSlidesBudgetSleepForTests(async (ms) => {
    recordedSleeps.push(ms);
  });

  const budget = createSlidesCallBudget({
    expensiveReadRatePerMinute: 10_000,
    expensiveReadBurst: 10_000,
    batchUpdateRatePerMinute: 10_000,
    batchUpdateBurst: 10_000,
    maxAttempts: 3,
  });

  let attempts = 0;
  const result = await budget.expensiveRead(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("quota");
      Object.assign(error, {
        code: 429,
        response: {
          headers: {
            "retry-after": "2",
          },
        },
      });
      throw error;
    }
    return "ok";
  }, { jobId: "job-1", opName: "presentations.get" });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(recordedSleeps, [2000]);
});

test("Slides call budget throws SlidesQuotaExhausted after max retry attempts", async () => {
  __resetSlidesCallBudgetForTests();
  __setSlidesBudgetSleepForTests(async () => {});

  const budget = createSlidesCallBudget({
    expensiveReadRatePerMinute: 10_000,
    expensiveReadBurst: 10_000,
    batchUpdateRatePerMinute: 10_000,
    batchUpdateBurst: 10_000,
    maxAttempts: 2,
  });

  await assert.rejects(
    () =>
      budget.expensiveRead(async () => {
        const error = new Error("still quota limited");
        Object.assign(error, { code: 429 });
        throw error;
      }, { jobId: "job-2", opName: "presentations.get" }),
    SlidesQuotaExhausted
  );
});

test("Slides call budget preserves non-quota retry exhaustion as the original error", async () => {
  __resetSlidesCallBudgetForTests();
  __setSlidesBudgetSleepForTests(async () => {});

  const budget = createSlidesCallBudget({
    expensiveReadRatePerMinute: 10_000,
    expensiveReadBurst: 10_000,
    batchUpdateRatePerMinute: 10_000,
    batchUpdateBurst: 10_000,
    maxAttempts: 2,
  });

  const upstreamError = new Error("service unavailable");
  Object.assign(upstreamError, { code: 503 });

  await assert.rejects(
    () =>
      budget.expensiveRead(async () => {
        throw upstreamError;
      }, { jobId: "job-3", opName: "presentations.get" }),
    (error) => {
      assert.equal(error, upstreamError);
      assert.equal(error instanceof SlidesQuotaExhausted, false);
      return true;
    }
  );
});
