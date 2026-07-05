import type { AppConfig } from "@translay/shared-config";
import {
  buildCloudTaskName,
  buildCloudTasksQueueName,
  createCloudTasksHttpTask,
} from "@translay/shared-config/dist/cloud-tasks";

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

  const parent = buildCloudTasksQueueName(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName
  );
  const taskName = buildCloudTaskName(
    config.gcpProjectId,
    config.cloudTasks.location,
    config.cloudTasks.queueName,
    buildTaskId(refundRequestId, delaySeconds)
  );
  const url = `https://${config.domain}/api/internal/refunds/process`;

  await createCloudTasksHttpTask({
    parent,
    name: taskName,
    url,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Cron-Secret": config.security.internalCronSecret,
    },
    payload: { refund_request_id: refundRequestId },
    serviceAccountEmail: config.cloudTasks.invokerServiceAccount,
    audience: `https://${config.domain}`,
    scheduleTime: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000) : undefined,
    dispatchDeadlineSeconds: 300,
  });
}
