import { CloudTasksClient } from "@google-cloud/tasks";
import type { WorkerConfig } from "@translay/shared-config";
import type { JobExecutionStage, JobId, TaskPayload } from "@translay/shared-contracts";

let tasksClient: CloudTasksClient | null = null;
const STAGE_BUSY_RETRY_FALLBACK_DELAY_MS = 30_000;
const STAGE_BUSY_RETRY_AFTER_LEASE_GRACE_MS = 2_000;
type StageTaskKind = "stage" | "lease-retry";

function getClient(): CloudTasksClient {
  if (!tasksClient) {
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

function buildStageTaskId(
  jobId: JobId | string,
  stage: JobExecutionStage,
  stageAttempt: number,
  taskKind: StageTaskKind = "stage"
): string {
  const normalizedStage = stage.replace(/_/g, "-");
  return taskKind === "lease-retry"
    ? `${String(jobId)}-${normalizedStage}-${stageAttempt}-lease-retry`
    : `${String(jobId)}-${normalizedStage}-${stageAttempt}`;
}

function getTaskName(config: WorkerConfig, taskId: string): string {
  const client = getClient();
  return client.taskPath(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName,
    taskId
  );
}

export async function enqueueStageTask(
  config: WorkerConfig,
  jobId: JobId | string,
  stage: JobExecutionStage,
  stageAttempt: number,
  options: {
    readonly scheduleTime?: Date;
    readonly taskKind?: StageTaskKind;
  } = {}
): Promise<string> {
  if (!config.cloudTasks.workerUrl) {
    throw new Error("WORKER_URL is not configured — cannot enqueue follow-up stage");
  }

  const client = getClient();
  const parent = client.queuePath(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName
  );
  const payload: TaskPayload = {
    job_id: String(jobId),
    attempt: 1,
    requested_at: new Date().toISOString(),
    expected_stage: stage,
    stage_attempt: stageAttempt,
  };
  const taskName = getTaskName(
    config,
    buildStageTaskId(jobId, stage, stageAttempt, options.taskKind)
  );

  try {
    await client.createTask({
      parent,
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST",
          url: `${config.cloudTasks.workerUrl}/tasks/translate`,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
          oidcToken: {
            serviceAccountEmail: config.cloudTasks.invokerServiceAccount,
            audience: config.cloudTasks.audience,
          },
        },
        dispatchDeadline: {
          seconds: stage === "authority" ? 1800 : 900,
        },
        scheduleTime: options.scheduleTime
          ? { seconds: Math.floor(options.scheduleTime.getTime() / 1000) }
          : undefined,
      },
    });
  } catch (error) {
    const err = error as { code?: number };
    if (err.code !== 6) {
      throw error;
    }
  }

  return taskName;
}

export function computeDelayedStageRetryScheduleTime(
  leaseExpiresAt: Date | null | undefined,
  now = new Date()
): Date {
  const leaseDeadlineMs = leaseExpiresAt?.getTime();
  if (!leaseDeadlineMs || Number.isNaN(leaseDeadlineMs)) {
    return new Date(now.getTime() + STAGE_BUSY_RETRY_FALLBACK_DELAY_MS);
  }

  return new Date(
    Math.max(now.getTime() + 1_000, leaseDeadlineMs + STAGE_BUSY_RETRY_AFTER_LEASE_GRACE_MS)
  );
}

export function __buildStageTaskIdForTests(
  jobId: JobId | string,
  stage: JobExecutionStage,
  stageAttempt: number,
  taskKind: StageTaskKind = "stage"
): string {
  return buildStageTaskId(jobId, stage, stageAttempt, taskKind);
}
