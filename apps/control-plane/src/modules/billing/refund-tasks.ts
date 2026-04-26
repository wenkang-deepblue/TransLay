import { CloudTasksClient } from "@google-cloud/tasks";
import type { AppConfig } from "@translay/shared-config";

let tasksClient: CloudTasksClient | null = null;

function getClient(): CloudTasksClient {
  if (!tasksClient) {
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

function buildTaskId(refundRequestId: string, delaySeconds: number): string {
  const bucket = Math.floor(Date.now() / 60_000);
  return `credit-refund-${refundRequestId}-${delaySeconds}-${bucket}`;
}

export async function enqueueCreditRefundProcessingTask(
  config: AppConfig,
  refundRequestId: string,
  delaySeconds = 0
): Promise<void> {
  if (config.nodeEnv !== "production") {
    return;
  }
  if (!config.security.internalCronSecret) {
    throw new Error("INTERNAL_CRON_SECRET is not configured");
  }
  if (!config.cloudTasks.invokerServiceAccount) {
    throw new Error("CLOUD_TASKS_INVOKER_SA is not configured");
  }

  const client = getClient();
  const parent = client.queuePath(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName
  );
  const taskName = client.taskPath(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName,
    buildTaskId(refundRequestId, delaySeconds)
  );
  const url = `https://${config.domain}/api/internal/refunds/process`;

  try {
    await client.createTask({
      parent,
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Cron-Secret": config.security.internalCronSecret,
          },
          body: Buffer.from(JSON.stringify({ refund_request_id: refundRequestId })).toString(
            "base64"
          ),
          oidcToken: {
            serviceAccountEmail: config.cloudTasks.invokerServiceAccount,
            audience: `https://${config.domain}`,
          },
        },
        scheduleTime:
          delaySeconds > 0
            ? { seconds: Math.floor(Date.now() / 1000) + delaySeconds }
            : undefined,
        dispatchDeadline: { seconds: 300 },
      },
    });
  } catch (error) {
    const err = error as { code?: number };
    if (err.code !== 6) {
      throw error;
    }
  }
}
