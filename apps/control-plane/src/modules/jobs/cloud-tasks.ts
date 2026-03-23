import { CloudTasksClient } from "@google-cloud/tasks";
import type { AppConfig } from "@translay/shared-config";
import type { TaskPayload, JobId } from "@translay/shared-contracts";

let tasksClient: CloudTasksClient | null = null;

function getClient(): CloudTasksClient {
  if (!tasksClient) {
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

export async function enqueueJob(
  config: AppConfig,
  jobId: JobId | string
): Promise<void> {
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
  };

  await client.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: `${workerUrl}/tasks/translate`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: {
          serviceAccountEmail: invokerSa,
        },
      },
    },
  });
}
