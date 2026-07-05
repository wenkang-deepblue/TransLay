import type { AppConfig } from "@translay/shared-config";
import {
  buildCloudTaskName,
  buildCloudTasksQueueName,
  createCloudTasksHttpTask,
  deleteCloudTask,
} from "@translay/shared-config/dist/cloud-tasks";
import type { JobExecutionStage, TaskPayload, JobId } from "@translay/shared-contracts";

type StageTaskKind = "stage" | "lease-retry" | "resume";

export function getTaskName(config: AppConfig, taskId: string): string {
  return buildCloudTaskName(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName,
    taskId
  );
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
    : taskKind === "resume"
      ? `${String(jobId)}-${normalizedStage}-${stageAttempt}-resume`
    : `${String(jobId)}-${normalizedStage}-${stageAttempt}`;
}

export async function enqueueJob(
  config: AppConfig,
  jobId: JobId | string,
  stage: JobExecutionStage = "extract",
  stageAttempt = 1,
  options: {
    readonly taskKind?: StageTaskKind;
  } = {}
): Promise<string> {
  const workerUrl = config.cloudTasks.workerUrl;
  if (!workerUrl) {
    throw new Error("WORKER_URL is not configured — cannot enqueue job");
  }

  const invokerSa = config.cloudTasks.invokerServiceAccount;
  if (!invokerSa) {
    throw new Error("CLOUD_TASKS_INVOKER_SA is not configured — cannot enqueue job");
  }

  const parent = buildCloudTasksQueueName(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName
  );

  const payload: TaskPayload = {
    job_id: jobId as string,
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
    url: `${workerUrl}/tasks/translate`,
    headers: { "Content-Type": "application/json" },
    payload,
    serviceAccountEmail: invokerSa,
    audience: config.cloudTasks.audience,
    dispatchDeadlineSeconds: stage === "authority" ? 1800 : 900,
  });
  return taskName;
}

export function __buildStageTaskIdForTests(
  jobId: JobId | string,
  stage: JobExecutionStage,
  stageAttempt: number,
  taskKind: StageTaskKind = "stage"
): string {
  return buildStageTaskId(jobId, stage, stageAttempt, taskKind);
}

export async function deleteQueuedJob(config: AppConfig, queuedTaskName?: string | null): Promise<void> {
  if (!queuedTaskName) {
    return;
  }
  await deleteCloudTask(queuedTaskName);
}
