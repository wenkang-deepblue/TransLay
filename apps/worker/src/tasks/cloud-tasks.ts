import type { WorkerConfig } from "@translay/shared-config";
import {
  buildCloudTaskName,
  buildCloudTasksQueueName,
  createCloudTasksHttpTask,
} from "@translay/shared-config/dist/cloud-tasks";
import type { JobExecutionStage, JobId, TaskPayload } from "@translay/shared-contracts";

const STAGE_BUSY_RETRY_FALLBACK_DELAY_MS = 30_000;
const STAGE_BUSY_RETRY_AFTER_LEASE_GRACE_MS = 2_000;
type StageTaskKind = "stage" | "lease-retry";

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
  return buildCloudTaskName(
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

  const parent = buildCloudTasksQueueName(
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

  await createCloudTasksHttpTask({
    parent,
    name: taskName,
    url: `${config.cloudTasks.workerUrl}/tasks/translate`,
    headers: { "Content-Type": "application/json" },
    payload,
    serviceAccountEmail: config.cloudTasks.invokerServiceAccount,
    audience: config.cloudTasks.audience,
    dispatchDeadlineSeconds: stage === "authority" ? 1800 : 900,
    scheduleTime: options.scheduleTime,
  });

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
