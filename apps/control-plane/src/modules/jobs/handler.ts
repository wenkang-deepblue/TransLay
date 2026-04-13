import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  CreateJobRequest,
  CreateJobResponse,
  CancelJobResponse,
  JobCanceledResponse,
  JobCompletedResponse,
  JobFailedResponse,
  JobProgressResponse,
  JobInProgressStatus,
  JobId,
  HostType,
  JobStatus,
  JobStatusResponse,
  JobWarning,
} from "@translay/shared-contracts";
import {
  validateCreateJobRequest,
  matchPresetLanguage,
  billingPeriodKey,
  buildJobCancelKey,
  getRemainingQuota,
  computeEntitlement,
  FREE_TIER_MAX_JOBS_PER_PERIOD,
} from "@translay/shared-domain";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { getUsageSummary } from "../../repositories/usage-repo";
import {
  createJob,
  getJobById,
  hasRunningJob,
  hasCompletedEquivalentJob,
  type JobRow,
  requestJobCancel,
  updateJobStatus,
} from "../../repositories/job-repo";
import {
  deleteIdempotencyRecord,
  findIdempotencyRecord,
  insertIdempotencyRecord,
} from "../../repositories/idempotency-repo";
import { deleteQueuedJob, enqueueJob } from "./cloud-tasks";
import { sendError } from "../../utils/errors";
import { assertMultiOk } from "../../utils/redis-helpers";

const CANCEL_KEY_TTL_SECONDS = 24 * 60 * 60;

// S8: Validate a string is a known job status
function isValidJobStatus(s: string): s is JobStatus {
  return (
    s === "pending" || s === "queued" || s === "extracting" ||
    s === "translating" || s === "writing" || s === "completed" ||
    s === "completed_with_warnings" ||
    s === "failed" || s === "canceled"
  );
}

function isRunningStatus(status: JobStatus): status is JobInProgressStatus {
  return (
    status === "pending" ||
    status === "queued" ||
    status === "extracting" ||
    status === "translating" ||
    status === "writing"
  );
}

function buildCanceledMessage(job: {
  total_units_billed: number;
}): string {
  if (job.total_units_billed > 0) {
    return `Translation canceled after ${job.total_units_billed} slide(s) were successfully translated. Those slides were counted toward your quota even though the job did not finish.`;
  }

  return "Translation canceled before any slide translation succeeded. No quota was charged.";
}

function formatExcludedSlidesMessage(excludedSlides: readonly number[]): string {
  const slideNoun = excludedSlides.length === 1 ? "Slide" : "Slides";
  const skipVerb = excludedSlides.length === 1 ? "was" : "were";
  const contentPronoun = excludedSlides.length === 1 ? "its" : "their";
  return `${slideNoun} ${excludedSlides.join(", ")} ${skipVerb} skipped because ${contentPronoun} content looked unsafe for model input.`;
}

function buildCompletedMessage(warnings: readonly JobWarning[]): string {
  const excludedSlides = listExcludedSlides(warnings);
  const reviewContainerCount = countUniqueWarningNodes(
    warnings.filter((warning) => warning.risk_reason !== "unsafe_slide_excluded")
  );

  if (excludedSlides.length > 0 && reviewContainerCount > 0) {
    const noun = reviewContainerCount === 1 ? "container" : "containers";
    return `Translation completed with ${reviewContainerCount} ${noun} requiring review. ${formatExcludedSlidesMessage(excludedSlides)}`;
  }

  if (excludedSlides.length > 0) {
    return `Translation completed with warnings. ${formatExcludedSlidesMessage(excludedSlides)}`;
  }

  if (reviewContainerCount > 0) {
    const noun = reviewContainerCount === 1 ? "container" : "containers";
    return `Translation completed with ${reviewContainerCount} ${noun} requiring review. Review the highlighted Slides containers for layout fidelity.`;
  }

  return "Translation completed successfully.";
}

function buildFailedMessage(baseMessage: string, warnings: readonly JobWarning[]): string {
  const excludedSlides = listExcludedSlides(warnings);
  if (excludedSlides.length === 0) {
    return baseMessage;
  }

  return `${baseMessage} ${formatExcludedSlidesMessage(excludedSlides)}`;
}

function normalizeWarnings(warnings: JobRow["warnings"] | null | undefined): JobRow["warnings"] {
  return Array.isArray(warnings) ? warnings : [];
}

function countUniqueWarningNodes(warnings: readonly JobWarning[]): number {
  return new Set(warnings.map((warning) => warning.node_id)).size;
}

function listExcludedSlides(warnings: readonly JobWarning[]): number[] {
  return [...new Set(
    warnings
      .filter((warning) => warning.risk_reason === "unsafe_slide_excluded")
      .map((warning) => warning.slide_index + 1)
  )].sort((left, right) => left - right);
}

function buildJobStatusResponse(
  job: JobRow,
  progress?: Record<string, string>
): JobStatusResponse {
  if (job.status === "completed" || job.status === "completed_with_warnings") {
    const normalizedWarnings = normalizeWarnings(job.warnings);
    const response: JobCompletedResponse = {
      job_id: job.id,
      status: job.status,
      progress_percent: 100,
      output_document_url: job.output_document_url ?? "",
      message: buildCompletedMessage(normalizedWarnings),
      ...(normalizedWarnings.length > 0 ? { warnings: normalizedWarnings } : {}),
    };
    return response;
  }

  if (job.status === "failed") {
    const normalizedWarnings = normalizeWarnings(job.warnings);
    const response: JobFailedResponse = {
      job_id: job.id,
      status: "failed",
      error: job.error_code ?? "JOB_INTERNAL_ERROR",
      message: buildFailedMessage(job.error_message ?? "Translation failed.", normalizedWarnings),
      ...(normalizedWarnings.length > 0 ? { warnings: normalizedWarnings } : {}),
    };
    return response;
  }

  if (job.status === "canceled") {
    const response: JobCanceledResponse = {
      job_id: job.id,
      status: "canceled",
      message: buildCanceledMessage(job),
      total_units_billed: job.total_units_billed,
      output_mode: job.output_mode,
      output_document_url: job.output_document_url ?? undefined,
    };
    return response;
  }

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
    translated_units_billed: job.total_units_billed,
  };

  return response;
}

export function __buildJobStatusResponseForTests(
  job: JobRow,
  progress?: Record<string, string>
): JobStatusResponse {
  return buildJobStatusResponse(job, progress);
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
    const hasCompletedHistory = await hasCompletedEquivalentJob(pool, {
      userId: auth.user_id,
      hostType: body.host_type,
      sourceDocId: body.document_id,
      targetLanguageInput: body.target_language_input,
      outputMode: body.output_mode,
      rangeMode: body.range_mode,
      rangeExpression: body.range_expression ?? null,
    });

    if (hasCompletedHistory && !body.resubmit) {
      sendError(res, "IDEMPOTENT_REPLAY");
      return;
    }

    const existingJobId = await findIdempotencyRecord(pool, auth.user_id, body.idempotency_key);
    if (existingJobId) {
      const existingJob = await getJobById(pool, existingJobId, auth.user_id);
      if (existingJob && isRunningStatus(existingJob.status)) {
        sendError(res, "CONCURRENT_JOB_RUNNING");
        return;
      }
      await deleteIdempotencyRecord(pool, auth.user_id, body.idempotency_key);
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
        targetDocId: body.target_document_id ?? null,
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

    const progressKey = `job_progress:${jobId}`;
    try {
      await enqueueJob(config, jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown enqueue error";
      console.error("Failed to enqueue job to Cloud Tasks:", message);

      await updateJobStatus(pool, jobId, "failed", {
        errorCode: "JOB_INTERNAL_ERROR",
        errorMessage: "Failed to enqueue job for processing. Please retry.",
      });

      await deleteIdempotencyRecord(pool, auth.user_id, body.idempotency_key).catch((cleanupErr) => {
        console.error(
          "Failed to cleanup idempotency record after enqueue failure:",
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        );
      });

      const failedResults = await redis
        .multi()
        .hset(progressKey, {
          status: "failed",
          progress_percent: "0",
          current_step: "failed",
          details: "Failed to queue job for processing",
        })
        .expire(progressKey, 24 * 60 * 60)
        .exec();

      assertMultiOk(failedResults, "jobs/create progress init failed");
      sendError(res, "JOB_INTERNAL_ERROR", "Failed to enqueue job for processing. Please retry.");
      return;
    }

    const results = await redis
      .multi()
      .hset(progressKey, {
        status: "queued",
        progress_percent: "0",
        current_step: "queued",
        details: "Job queued for processing",
      })
      .expire(progressKey, 24 * 60 * 60)
      .exec();

    assertMultiOk(results, "jobs/create progress init");

    const response: CreateJobResponse = {
      status: "accepted",
      job_id: jobId,
      queued: true,
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

    if (
      job.status === "completed" ||
      job.status === "completed_with_warnings" ||
      job.status === "failed" ||
      job.status === "canceled"
    ) {
      res.json(buildJobStatusResponse(job));
      return;
    }

    const progress = await redis.hgetall(`job_progress:${job.id}`);
    res.json(buildJobStatusResponse(job, progress));
  };
}

export function cancelJobHandler(pool: Pool, redis: Redis, config: AppConfig) {
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

    if (job.status === "completed" || job.status === "completed_with_warnings") {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "already_completed",
        message: "This translation job has already completed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "failed") {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "already_failed",
        message: "This translation job has already failed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "canceled") {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "already_canceled",
        message: buildCanceledMessage(job),
      };
      res.json(response);
      return;
    }

    if (job.status === "pending" || job.status === "queued") {
      await deleteQueuedJob(config, job.id);
      await updateJobStatus(pool, job.id, "canceled");
      const progressKey = `job_progress:${job.id}`;
      const results = await redis
        .multi()
        .del(buildJobCancelKey(job.id))
        .hset(progressKey, {
          status: "canceled",
          progress_percent: "0",
          current_step: "canceled",
          details: "Translation canceled before processing started. No quota was charged.",
        })
        .expire(progressKey, CANCEL_KEY_TTL_SECONDS)
        .exec();

      assertMultiOk(results, "jobs/cancel pending progress");

      const response: CancelJobResponse = {
        job_id: job.id,
        status: "canceled",
        message: "Translation canceled before processing started.",
      };
      res.json(response);
      return;
    }

    const cancelRequested = await requestJobCancel(pool, job.id, auth.user_id);
    if (!cancelRequested) {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "cancel_requested",
        message: "Cancellation has already been requested. The worker will stop at the next safe checkpoint.",
      };
      res.json(response);
      return;
    }

    const progressKey = `job_progress:${job.id}`;
    const results = await redis
      .multi()
      .set(buildJobCancelKey(job.id), new Date().toISOString(), "EX", CANCEL_KEY_TTL_SECONDS)
      .hset(progressKey, {
        details: "Cancellation requested. The worker will stop at the next safe checkpoint.",
      })
      .expire(progressKey, CANCEL_KEY_TTL_SECONDS)
      .exec();

    assertMultiOk(results, "jobs/cancel request");

    const response: CancelJobResponse = {
      job_id: job.id,
      status: "cancel_requested",
      message: "Cancellation requested. The current step will stop as soon as possible.",
    };
    res.json(response);
  };
}
