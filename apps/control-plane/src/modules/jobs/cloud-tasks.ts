import { CloudTasksClient } from "@google-cloud/tasks";
import type { AppConfig } from "@translay/shared-config";
import type { JobExecutionStage, TaskPayload, JobId } from "@translay/shared-contracts";

let tasksClient: CloudTasksClient | null = null;
type StageTaskKind = "stage" | "lease-retry";

function getClient(): CloudTasksClient {
  if (!tasksClient) {
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

export function getTaskName(config: AppConfig, taskId: string): string {
  const client = getClient();
  return client.taskPath(
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

  const client = getClient();

  const parent = client.queuePath(
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

  try {
    await client.createTask({
      parent,
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST",
          url: `${workerUrl}/tasks/translate`,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
          oidcToken: {
            serviceAccountEmail: invokerSa,
            audience: config.cloudTasks.audience,
          },
        },
        dispatchDeadline: {
          seconds: stage === "authority" ? 1800 : 900,
        },
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
  const client = getClient();
  try {
    await client.deleteTask({ name: queuedTaskName });
  } catch (error) {
    const err = error as { code?: number };
    if (err.code === 5) {
      return;
    }
    throw error;
  }
}
