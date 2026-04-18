import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerConfig } from "@translay/shared-config";
import { StageLeaseBusyError } from "../pipelines/job-pipeline";
import { taskHandler } from "./task-handler";

function createConfig(): WorkerConfig {
  return {
    port: 8080,
    nodeEnv: "test",
    gcpProjectId: "YOUR_GCP_PROJECT_ID",
    gcpRegion: "us-central1",
    db: {
      host: "localhost",
      port: 5432,
      name: "translay",
      user: "postgres",
      password: "postgres",
    },
    redis: {
      host: "localhost",
      port: 6379,
    },
    vertex: {
      model: "gemini-3.1-flash-lite-preview",
      location: "global",
    },
    gemmaGpu: {
      url: "",
    },
    cloudTasks: {
      queueName: "YOUR_CLOUD_TASKS_QUEUE",
      location: "us-central1",
      workerUrl: "https://worker.example.com",
      audience: "",
      invokerServiceAccount: "",
    },
    debug: {
      captureLlmOutputs: false,
      allowDevTestRawOutputPersistence: false,
      llmOutputRetentionHours: 72,
    },
    security: {
      kmsKeyName: null,
    },
  };
}

test("taskHandler re-enqueues StageLeaseBusy work near lease expiry instead of returning 429", async () => {
  const enqueued: Array<{
    jobId: string;
    stage: string;
    stageAttempt: number;
    scheduleTime?: Date;
  }> = [];

  const handler = taskHandler({} as never, {} as never, createConfig(), {
    runJobPipeline: async () => {
      throw new StageLeaseBusyError(
        "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
        "authority",
        new Date("2026-04-16T10:32:00.000Z")
      );
    },
    enqueueStageTask: async (_config, jobId, stage, stageAttempt, options) => {
      enqueued.push({
        jobId: String(jobId),
        stage,
        stageAttempt,
        scheduleTime: options?.scheduleTime,
      });
      return "task-name";
    },
  });

  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await handler(
    {
      get: () => undefined,
      body: {
        job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
        attempt: 1,
        requested_at: "2026-04-16T10:00:00.000Z",
        expected_stage: "authority",
        stage_attempt: 3,
      },
    } as never,
    response as never
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    accepted: true,
    delayed: true,
    job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.stage, "authority");
  assert.equal(enqueued[0]?.stageAttempt, 3);
  assert.ok(enqueued[0]?.scheduleTime instanceof Date);
  assert.ok(enqueued[0]!.scheduleTime!.getTime() > Date.parse("2026-04-16T10:32:00.000Z"));
});

test("taskHandler keeps returning 429 when StageLeaseBusy payload lacks stage attempt", async () => {
  const handler = taskHandler({} as never, {} as never, createConfig(), {
    runJobPipeline: async () => {
      throw new StageLeaseBusyError(
        "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
        "authority",
        new Date("2026-04-16T10:32:00.000Z")
      );
    },
    enqueueStageTask: async () => {
      throw new Error("should not enqueue without stage attempt");
    },
  });

  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await handler(
    {
      get: () => undefined,
      body: {
        job_id: "0f7ea113-2d74-4d13-a2c2-8d325d3fb7b8",
        attempt: 1,
        requested_at: "2026-04-16T10:00:00.000Z",
        expected_stage: "authority",
      },
    } as never,
    response as never
  );

  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, { error: "STAGE_LEASE_BUSY" });
});
