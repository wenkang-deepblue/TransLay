import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { WorkerConfig } from "@translay/shared-config";
import type { TaskPayload } from "@translay/shared-contracts";
import { runJobPipeline, StageLeaseBusyError } from "../pipelines/job-pipeline";
import {
  computeDelayedStageRetryScheduleTime,
  enqueueStageTask,
} from "../tasks/cloud-tasks";

const oidcClient = new OAuth2Client();
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function taskHandler(
  pool: Pool,
  redis: Redis,
  config: WorkerConfig,
  deps: {
    readonly runJobPipeline?: typeof runJobPipeline;
    readonly enqueueStageTask?: typeof enqueueStageTask;
  } = {}
) {
  const runPipeline = deps.runJobPipeline ?? runJobPipeline;
  const enqueueTask = deps.enqueueStageTask ?? enqueueStageTask;
  return async (req: Request, res: Response): Promise<void> => {
    const authError = await verifyTaskRequest(req, config);
    if (authError) {
      console.error(`Rejected worker task request: ${authError}`);
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const payload = parseTaskPayload(req.body);
    if (!payload) {
      console.error("Invalid task payload received by worker");
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }

    console.log(`Received task for job ${payload.job_id}, attempt ${payload.attempt}`);

    try {
      await runPipeline(pool, redis, config, payload);
      res.status(200).json({ accepted: true, job_id: payload.job_id });
    } catch (err) {
      if (err instanceof StageLeaseBusyError) {
        console.warn(`Stage lease busy for job ${payload.job_id}: ${err.stage}`);
        if (!payload.stage_attempt) {
          res.status(429).json({ error: "STAGE_LEASE_BUSY" });
          return;
        }

        const scheduleTime = computeDelayedStageRetryScheduleTime(err.leaseExpiresAt);
        await enqueueTask(config, payload.job_id, err.stage, payload.stage_attempt, {
          scheduleTime,
          taskKind: "lease-retry",
        });
        res.status(200).json({ accepted: true, delayed: true, job_id: payload.job_id });
        return;
      }
      console.error(`Pipeline fatal error for job ${payload.job_id}:`, (err as Error).message);
      res.status(500).json({ error: "TASK_EXECUTION_FAILED" });
    }
  };
}

async function verifyTaskRequest(
  req: Request,
  config: WorkerConfig
): Promise<string | null> {
  const authHeader = req.get("authorization");
  if (!authHeader) {
    return allowUnsignedLocalRequest(config)
      ? null
      : "missing Authorization header";
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return "invalid Authorization header format";
  }

  if (!config.cloudTasks.audience) {
    return allowUnsignedLocalRequest(config)
      ? null
      : "Cloud Tasks audience is not configured";
  }

  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: token,
      audience: config.cloudTasks.audience,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      return "OIDC token payload missing";
    }

    if (!GOOGLE_ISSUERS.has(payload.iss ?? "")) {
      return "unexpected OIDC issuer";
    }

    const email = typeof payload.email === "string" ? payload.email : "";
    if (
      config.cloudTasks.invokerServiceAccount &&
      email !== config.cloudTasks.invokerServiceAccount
    ) {
      return "unexpected invoker service account";
    }

    if (payload.email_verified === false) {
      return "invoker service account email is not verified";
    }
  } catch {
    return "OIDC verification failed";
  }

  return null;
}

function parseTaskPayload(value: unknown): TaskPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<TaskPayload>;
  if (typeof payload.job_id !== "string" || !UUID_RE.test(payload.job_id)) {
    return null;
  }

  const attempt = payload.attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    return null;
  }

  if (
    typeof payload.requested_at !== "string" ||
    Number.isNaN(Date.parse(payload.requested_at))
  ) {
    return null;
  }

  return {
    job_id: payload.job_id,
    attempt,
    requested_at: payload.requested_at,
    expected_stage:
      typeof payload.expected_stage === "string" ? payload.expected_stage : undefined,
    stage_attempt:
      typeof payload.stage_attempt === "number" && Number.isInteger(payload.stage_attempt)
        ? payload.stage_attempt
        : undefined,
  };
}

function allowUnsignedLocalRequest(config: WorkerConfig): boolean {
  return (
    config.nodeEnv !== "production" &&
    !config.cloudTasks.audience &&
    !config.cloudTasks.invokerServiceAccount
  );
}
