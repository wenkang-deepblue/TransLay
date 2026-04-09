import type Redis from "ioredis";
import type { JobStatus } from "@translay/shared-contracts";

const PROGRESS_TTL = 86400; // 24 hours

export async function setJobProgress(
  redis: Redis,
  jobId: string,
  data: {
    status: JobStatus;
    progress_percent: number;
    current_step?: string;
    details?: string;
  }
): Promise<void> {
  const key = `job_progress:${jobId}`;
  const fields: Record<string, string> = {
    status: data.status,
    progress_percent: String(data.progress_percent),
  };
  if (data.current_step) fields.current_step = data.current_step;
  if (data.details) fields.details = data.details;

  const pipeline = redis.pipeline();
  pipeline.hset(key, fields);
  pipeline.expire(key, PROGRESS_TTL);
  await pipeline.exec();
}
