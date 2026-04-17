import test from "node:test";
import assert from "node:assert/strict";
import {
  VertexQuotaExhausted,
  createVertexCallBudget,
  __resetVertexCallBudgetForTests,
  __setVertexBudgetSleepForTests,
} from "./vertex-call-budget";

test("Vertex call budget honors Retry-After seconds before succeeding", async () => {
  __resetVertexCallBudgetForTests();
  const recordedSleeps: number[] = [];
  __setVertexBudgetSleepForTests(async (ms) => {
    recordedSleeps.push(ms);
  });

  const budget = createVertexCallBudget({
    ratePerMinute: 10_000,
    burst: 10_000,
    maxAttempts: 3,
  });

  let attempts = 0;
  const result = await budget.generateContent(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("quota");
      Object.assign(error, {
        status: 429,
        response: {
          headers: {
            "retry-after": "2",
          },
        },
      });
      throw error;
    }
    return "ok";
  }, { opName: "generateContent", model: "gemini-3.1-flash-lite-preview" });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(recordedSleeps, [2000]);
});

test("Vertex call budget throws VertexQuotaExhausted after max retry attempts", async () => {
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});

  const budget = createVertexCallBudget({
    ratePerMinute: 10_000,
    burst: 10_000,
    maxAttempts: 2,
  });

  await assert.rejects(
    () =>
      budget.generateContent(async () => {
        const error = new Error("still quota limited");
        Object.assign(error, { status: 429 });
        throw error;
      }, { opName: "generateContent", model: "gemini-3.1-flash-lite-preview" }),
    VertexQuotaExhausted
  );
});

test("Vertex call budget preserves non-quota retry exhaustion as the original error", async () => {
  __resetVertexCallBudgetForTests();
  __setVertexBudgetSleepForTests(async () => {});

  const budget = createVertexCallBudget({
    ratePerMinute: 10_000,
    burst: 10_000,
    maxAttempts: 2,
  });

  const upstreamError = new Error("service unavailable");
  Object.assign(upstreamError, { status: 503 });

  await assert.rejects(
    () =>
      budget.generateContent(async () => {
        throw upstreamError;
      }, { opName: "generateContent", model: "gemini-3.1-flash-lite-preview" }),
    (error) => {
      assert.equal(error, upstreamError);
      assert.equal(error instanceof VertexQuotaExhausted, false);
      return true;
    }
  );
});
