import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  CreateJobRequest,
  CreateJobResponse,
  JobCompletedResponse,
  JobFailedResponse,
  JobProgressResponse,
  JobInProgressStatus,
  JobId,
  HostType,
  JobStatus,
} from "@translay/shared-contracts";
import {
  validateCreateJobRequest,
  matchPresetLanguage,
  billingPeriodKey,
  getRemainingQuota,
  computeEntitlement,
  FREE_TIER_MAX_JOBS_PER_PERIOD,
} from "@translay/shared-domain";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { getUsageSummary } from "../../repositories/usage-repo";
import { createJob, getJobById, hasRunningJob } from "../../repositories/job-repo";
import { findIdempotencyRecord, insertIdempotencyRecord } from "../../repositories/idempotency-repo";
import { enqueueJob } from "./cloud-tasks";
import { sendError } from "../../utils/errors";
import { assertMultiOk } from "../../utils/redis-helpers";

// S8: Validate a string is a known job status
function isValidJobStatus(s: string): s is JobStatus {
  return (
    s === "pending" || s === "queued" || s === "extracting" ||
    s === "translating" || s === "writing" || s === "completed" ||
    s === "failed" || s === "canceled"
  );
}

// I10: Exhaustive host-type usage lookup
function getHostUsed(
  usage: { slides_used: number; docs_pages_used: number; sheets_cells_used: number },
  hostType: HostType
): number {
  switch (hostType) {
    case "slides":
      return usage.slides_used;
    case "docs":
      return usage.docs_pages_used;
    case "sheets":
      return usage.sheets_cells_used;
    default: {
      const _exhaustive: never = hostType;
      throw new Error(`Unknown host type: ${_exhaustive}`);
    }
  }
}

export function createJobHandler(pool: Pool, redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const validationError = validateCreateJobRequest(req.body);
    if (validationError) {
      sendError(res, "VALIDATION_ERROR", validationError);
      return;
    }

    // S5: body is validated; cast is safe after validateCreateJobRequest returns null
    const body = req.body as CreateJobRequest;

    const existingJobId = await findIdempotencyRecord(pool, auth.user_id, body.idempotency_key);
    if (existingJobId) {
      sendError(res, "IDEMPOTENT_REPLAY");
      return;
    }

    const running = await hasRunningJob(pool, auth.user_id);
    if (running) {
      sendError(res, "CONCURRENT_JOB_RUNNING");
      return;
    }

    const sub = await getActiveSubscription(pool, auth.user_id);
    if (!sub) {
      sendError(res, "JOB_INTERNAL_ERROR", "No subscription found");
      return;
    }

    const entitlement = computeEntitlement({
      plan_type: sub.plan_type,
      subscription_status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: sub.current_period_end,
    });

    if (!entitlement.active && entitlement.access === "free" && sub.plan_type !== "free") {
      sendError(res, "ACCESS_DENIED");
      return;
    }

    const periodKey = billingPeriodKey();
    const usage = await getUsageSummary(pool, auth.user_id, periodKey);

    if (sub.plan_type === "free" && usage.total_jobs >= FREE_TIER_MAX_JOBS_PER_PERIOD) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }

    const remaining = getRemainingQuota(sub.plan_type, body.host_type, getHostUsed(usage, body.host_type));
    if (remaining <= 0) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }

    const targetLanguageCode = matchPresetLanguage(body.target_language_input);

    const client = await pool.connect();
    let jobId: JobId;
    try {
      await client.query("BEGIN");

      jobId = await createJob(client, {
        userId: auth.user_id,
        hostType: body.host_type,
        sourceDocId: body.document_id,
        sourceDocName: body.document_name,
        sourceLangMode: body.source_language_mode,
        targetLanguageInput: body.target_language_input,
        targetLanguageCode,
        outputMode: body.output_mode,
        rangeMode: body.range_mode,
        rangeExpression: body.range_expression ?? null,
      });

      const fingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");

      await insertIdempotencyRecord(client, {
        userId: auth.user_id,
        idempotencyKey: body.idempotency_key,
        jobId,
        requestFingerprint: fingerprint,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // C2: Track whether enqueue actually succeeded
    let enqueued = false;
    try {
      await enqueueJob(config, jobId);
      enqueued = true;
    } catch (err) {
      console.error("Failed to enqueue job to Cloud Tasks:", (err as Error).message);
      // Job is in DB with status=pending but not enqueued.
      // A recovery sweep (Phase 6) will re-enqueue orphaned pending jobs.
    }

    const progressKey = `job_progress:${jobId}`;
    const results = await redis
      .multi()
      .hset(progressKey, {
        status: enqueued ? "queued" : "pending",
        progress_percent: "0",
        current_step: enqueued ? "queued" : "pending",
        details: enqueued ? "Job queued for processing" : "Job created, awaiting enqueue",
      })
      .expire(progressKey, 24 * 60 * 60)
      .exec();

    assertMultiOk(results, "jobs/create progress init");

    const response: CreateJobResponse = {
      status: "accepted",
      job_id: jobId,
      queued: enqueued,
    };

    res.status(201).json(response);
  };
}

// S1: UUID v4 format validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getJobHandler(pool: Pool, redis: Redis) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const jobId = req.params.jobId as string;
    if (!jobId || !UUID_RE.test(jobId)) {
      sendError(res, "VALIDATION_ERROR", "Invalid job ID format");
      return;
    }

    const job = await getJobById(pool, jobId, auth.user_id);
    if (!job) {
      sendError(res, "NOT_FOUND", "Job not found");
      return;
    }

    if (job.status === "completed") {
      const response: JobCompletedResponse = {
        job_id: job.id,
        status: "completed",
        progress_percent: 100,
        output_document_url: job.output_document_url ?? "",
        message: "Translation completed successfully.",
      };
      res.json(response);
      return;
    }

    if (job.status === "failed") {
      const response: JobFailedResponse = {
        job_id: job.id,
        status: "failed",
        error: job.error_code ?? "JOB_INTERNAL_ERROR",
        message: job.error_message ?? "Translation failed.",
      };
      res.json(response);
      return;
    }

    // S8: Validate Redis status before using in response
    const progress = await redis.hgetall(`job_progress:${job.id}`);
    const redisStatus = progress?.status;
    const resolvedStatus: JobStatus = (redisStatus && isValidJobStatus(redisStatus))
      ? redisStatus
      : job.status;

    const response: JobProgressResponse = {
      job_id: job.id,
      status: resolvedStatus as JobInProgressStatus,
      progress_percent: progress?.progress_percent ? parseInt(progress.progress_percent, 10) : 0,
      current_step: progress?.current_step,
      details: progress?.details,
    };

    res.json(response);
  };
}
