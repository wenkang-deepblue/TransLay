import test from "node:test";
import assert from "node:assert/strict";
import { __buildStageTaskIdForTests } from "./cloud-tasks";

test("control-plane stage task ids are deterministic for normal queueing", () => {
  assert.equal(
    __buildStageTaskIdForTests("job-1", "extract", 1),
    "job-1-extract-1"
  );
  assert.equal(
    __buildStageTaskIdForTests("job-1", "authority", 4, "lease-retry"),
    "job-1-authority-4-lease-retry"
  );
});
