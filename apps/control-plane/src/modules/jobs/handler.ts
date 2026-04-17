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
  JobSlideResult,
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
import { listJobSlideResults } from "../../repositories/job-slide-result-repo";
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
  net_billed_slides: number;
}): string {
  const billedSlides = job.net_billed_slides;
  if (billedSlides > 0) {
    return `Translation canceled after ${billedSlides} slide(s) were successfully translated. Those slides were counted toward your quota even though the job did not finish.`;
  }

  return "Translation canceled before any slide translation succeeded. No quota was charged.";
}

function formatExcludedSlidesMessage(excludedSlides: readonly number[]): string {
  const slideNoun = excludedSlides.length === 1 ? "Slide" : "Slides";
  const skipVerb = excludedSlides.length === 1 ? "was" : "were";
  const contentPronoun = excludedSlides.length === 1 ? "its" : "their";
  return `${slideNoun} ${excludedSlides.join(", ")} ${skipVerb} skipped because ${contentPronoun} content looked unsafe for model input.`;
}

type TerminalSlideSummary = {
  fully_delivered_body_slide_indices: number[];
  content_only_slide_indices: number[];
  notes_only_slide_indices: number[];
  body_partial_slide_indices: number[];
  skipped_slide_indices: number[];
  refunded_slide_indices: number[];
};

function normalizeWarnings(warnings: JobRow["warnings"] | null | undefined): JobRow["warnings"] {
  return Array.isArray(warnings) ? warnings : [];
}

function isSlideExecutionWarningReason(reason: JobWarning["risk_reason"]): boolean {
  return (
    reason === "slide_translation_failed" ||
    reason === "slide_materialization_failed" ||
    reason === "slide_write_failed" ||
    reason === "slide_charge_refunded"
  );
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

function summarizeTerminalSlideResults(
  slideResults: readonly JobSlideResult[]
): TerminalSlideSummary {
  const fullyDeliveredBody = new Set<number>();
  const contentOnly = new Set<number>();
  const notesOnly = new Set<number>();
  const bodyPartial = new Set<number>();
  const skipped = new Set<number>();
  const refunded = new Set<number>();

  for (const slideResult of slideResults) {
    const slideNumber = slideResult.slide_index + 1;
    if (slideResult.content_output_visible) {
      const bodyNodeCount = slideResult.body_node_count ?? 0;
      const bodyWrittenNodeCount = slideResult.body_written_node_count ?? 0;
      const bodyFailedNodeCount = slideResult.body_failed_node_count ?? 0;
      if (
        bodyNodeCount > 0 &&
        bodyWrittenNodeCount === bodyNodeCount &&
        bodyFailedNodeCount === 0
      ) {
        fullyDeliveredBody.add(slideNumber);
      }
      if (bodyFailedNodeCount > 0) {
        bodyPartial.add(slideNumber);
      }
    }

    if (
      slideResult.output_visible &&
      slideResult.notes_present &&
      slideResult.content_output_visible &&
      !slideResult.notes_output_visible
    ) {
      contentOnly.add(slideNumber);
    }

    if (
      slideResult.output_visible &&
      slideResult.notes_present &&
      !slideResult.content_output_visible &&
      slideResult.notes_output_visible
    ) {
      notesOnly.add(slideNumber);
    }

    if (
      slideResult.status === "excluded_unsafe" ||
      slideResult.status === "skipped_translation_failed" ||
      slideResult.status === "skipped_materialization_failed" ||
      slideResult.status === "skipped_write_failed" ||
      (slideResult.status === "translated" && !slideResult.output_visible)
    ) {
      skipped.add(slideNumber);
    }

    if (shouldSurfaceRefund(slideResult)) {
      refunded.add(slideNumber);
    }
  }

  return {
    fully_delivered_body_slide_indices: [...fullyDeliveredBody].sort((left, right) => left - right),
    content_only_slide_indices: [...contentOnly].sort((left, right) => left - right),
    notes_only_slide_indices: [...notesOnly].sort((left, right) => left - right),
    body_partial_slide_indices: [...bodyPartial].sort((left, right) => left - right),
    skipped_slide_indices: [...skipped].sort((left, right) => left - right),
    refunded_slide_indices: [...refunded].sort((left, right) => left - right),
  };
}

function buildSyntheticSlideWarnings(
  slideResults: readonly JobSlideResult[]
): JobWarning[] {
  const warnings: JobWarning[] = [];

  for (const slideResult of slideResults) {
    const warningNodeIdBase = `slide_result_${slideResult.slide_index + 1}`;
    if (slideResult.status === "skipped_translation_failed") {
      warnings.push({
        node_id: warningNodeIdBase,
        slide_index: slideResult.slide_index,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_translation_failed",
      });
    } else if (slideResult.status === "skipped_materialization_failed") {
      warnings.push({
        node_id: warningNodeIdBase,
        slide_index: slideResult.slide_index,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_materialization_failed",
      });
    } else if (slideResult.status === "skipped_write_failed") {
      warnings.push({
        node_id: warningNodeIdBase,
        slide_index: slideResult.slide_index,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_write_failed",
      });
    }

    if (shouldSurfaceRefund(slideResult)) {
      warnings.push({
        node_id: `${warningNodeIdBase}_refund`,
        slide_index: slideResult.slide_index,
        archetype: "plain_text",
        risk_level: "high",
        risk_reason: "slide_charge_refunded",
      });
    }
  }

  return warnings;
}

function shouldSurfaceRefund(slideResult: JobSlideResult): boolean {
  return slideResult.status !== "excluded_unsafe" && slideResult.refunded;
}

function mergeWarningsWithSlideResults(
  warnings: readonly JobWarning[],
  slideResults: readonly JobSlideResult[]
): JobWarning[] {
  const merged = [...warnings];
  const seen = new Set(merged.map((warning) => `${warning.slide_index}:${warning.risk_reason}:${warning.node_id}`));

  for (const warning of buildSyntheticSlideWarnings(slideResults)) {
    const key = `${warning.slide_index}:${warning.risk_reason}:${warning.node_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(warning);
  }

  return merged;
}

function formatSlideList(slides: readonly number[]): string {
  return slides.join(", ");
}

function formatRefundedSlideList(slides: readonly number[]): string {
  return slides.map((slide) => `slide ${slide}`).join(", ");
}

function formatSlideReference(
  slides: readonly number[],
  singularLabel = "slide",
  pluralLabel = "slides"
): string {
  const label = slides.length === 1 ? singularLabel : pluralLabel;
  return `${label} ${formatSlideList(slides)}`;
}

function listPartialContentOnlySlides(slideResults: readonly JobSlideResult[]): number[] {
  return slideResults
    .filter((slideResult) =>
      slideResult.output_visible &&
      slideResult.notes_present &&
      slideResult.content_output_visible &&
      !slideResult.notes_output_visible
    )
    .map((slideResult) => slideResult.slide_index + 1)
    .sort((left, right) => left - right);
}

function listPartialNotesOnlySlides(slideResults: readonly JobSlideResult[]): number[] {
  return slideResults
    .filter((slideResult) =>
      slideResult.output_visible &&
      slideResult.notes_present &&
      !slideResult.content_output_visible &&
      slideResult.notes_output_visible
    )
    .map((slideResult) => slideResult.slide_index + 1)
    .sort((left, right) => left - right);
}

function listNotesTruncatedSlides(slideResults: readonly JobSlideResult[]): number[] {
  return slideResults
    .filter((slideResult) => slideResult.notes_truncated)
    .map((slideResult) => slideResult.slide_index + 1)
    .sort((left, right) => left - right);
}

function buildSlideDeliveryFailureMessage(
  skippedSlides: readonly number[],
  refundedSlides: readonly number[]
): string {
  if (skippedSlides.length === 0) {
    return "";
  }

  const slideNoun = skippedSlides.length === 1 ? "Slide" : "Slides";
  const refundVerb = skippedSlides.length === 1 ? "was" : "were";
  if (refundedSlides.length === 0) {
    return `${slideNoun} ${formatSlideList(skippedSlides)} could not be delivered due to translation or write-back issues.`;
  }

  if (refundedSlides.length === skippedSlides.length) {
    return `${slideNoun} ${formatSlideList(skippedSlides)} could not be delivered due to translation or write-back issues and ${refundVerb} refunded.`;
  }

  return `${slideNoun} ${formatSlideList(skippedSlides)} could not be delivered. Refunded: ${formatRefundedSlideList(refundedSlides)}.`;
}

function buildCompletedMessage(
  warnings: readonly JobWarning[],
  slideSummary: TerminalSlideSummary
  ,
  slideResults: readonly JobSlideResult[]
): string {
  const excludedSlides = listExcludedSlides(warnings);
  const reviewContainerCount = countUniqueWarningNodes(
    warnings.filter((warning) =>
      warning.risk_reason !== "unsafe_slide_excluded" &&
      !isSlideExecutionWarningReason(warning.risk_reason)
    )
  );
  const skippedDeliveredSlides = slideSummary.skipped_slide_indices.filter(
    (slideNumber) => !excludedSlides.includes(slideNumber)
  );

  const parts: string[] = [];
  if (skippedDeliveredSlides.length > 0) {
    parts.push(
      buildSlideDeliveryFailureMessage(
        skippedDeliveredSlides,
        slideSummary.refunded_slide_indices
      )
    );
  }

  if (excludedSlides.length > 0) {
    parts.push(formatExcludedSlidesMessage(excludedSlides));
  }

  const contentOnlySlides = slideSummary.content_only_slide_indices;
  if (contentOnlySlides.length > 0) {
    parts.push(`Content-only delivery: ${formatSlideReference(contentOnlySlides)}.`);
  }

  const notesOnlySlides = slideSummary.notes_only_slide_indices;
  if (notesOnlySlides.length > 0) {
    parts.push(`Notes-only fallback: ${formatSlideReference(notesOnlySlides)}.`);
  }

  if (slideSummary.body_partial_slide_indices.length > 0) {
    parts.push(
      `Partially translated slides: ${formatSlideList(slideSummary.body_partial_slide_indices)}, not billed.`
    );
  }

  const truncatedNotesSlides = listNotesTruncatedSlides(slideResults);
  if (truncatedNotesSlides.length > 0) {
    parts.push(`Speaker notes were truncated to 5000 characters on slides ${formatSlideList(truncatedNotesSlides)} before translation.`);
  }

  if (reviewContainerCount > 0) {
    const noun = reviewContainerCount === 1 ? "container" : "containers";
    parts.push(`Review ${reviewContainerCount} ${noun} for layout fidelity.`);
  }

  if (parts.length > 0) {
    return `Translation completed with warnings. ${parts.join(" ")}`.trim();
  }

  return "Translation completed successfully.";
}

function buildFailedMessage(
  baseMessage: string,
  warnings: readonly JobWarning[],
  slideSummary: TerminalSlideSummary,
  slideResults: readonly JobSlideResult[]
): string {
  const parts = [baseMessage];
  if (slideSummary.refunded_slide_indices.length > 0) {
    parts.push(`Refunded: ${formatRefundedSlideList(slideSummary.refunded_slide_indices)}.`);
  }

  const excludedSlides = listExcludedSlides(warnings);
  if (excludedSlides.length > 0) {
    parts.push(formatExcludedSlidesMessage(excludedSlides));
  }

  const contentOnlySlides = slideSummary.content_only_slide_indices;
  if (contentOnlySlides.length > 0) {
    parts.push(`Content-only delivery: ${formatSlideReference(contentOnlySlides)}.`);
  }

  const notesOnlySlides = slideSummary.notes_only_slide_indices;
  if (notesOnlySlides.length > 0) {
    parts.push(`Notes-only fallback: ${formatSlideReference(notesOnlySlides)}.`);
  }

  if (slideSummary.body_partial_slide_indices.length > 0) {
    parts.push(
      `Partially translated slides: ${formatSlideList(slideSummary.body_partial_slide_indices)}, not billed.`
    );
  }

  return parts.join(" ");
}

function buildSynthesizedProgress(job: JobRow): {
  progress_percent: number;
  current_step?: string;
  details?: string;
} {
  switch (job.current_stage) {
    case "extract":
      return {
        progress_percent: job.stage_status === "queued" ? 0 : 5,
        current_step: "extracting_content",
        details:
          job.stage_status === "queued"
            ? "Queued extraction stage."
            : "Extracting presentation content.",
      };
    case "layout_semantics": {
      const completed = toNumber((job.stage_cursor as Record<string, unknown>).completed_slide_count);
      const total = Math.max(
        1,
        toNumber((job.stage_cursor as Record<string, unknown>).total_slide_count) ||
          toNumber((job.stage_payload as Record<string, unknown>).total_selected_slides)
      );
      return {
        progress_percent:
          job.stage_status === "queued"
            ? 15
            : 20 + Math.round((Math.min(completed, total) / total) * 20),
        current_step: "layout_semantics",
        details:
          job.stage_status === "queued"
            ? "Queued layout analysis stage."
            : `Analyzing layout semantics for ${completed}/${total} safe slide(s).`,
      };
    }
    case "authority":
      return {
        progress_percent: job.status === "writing" ? 80 : 45,
        current_step: job.status === "writing" ? "writing_back" : "authority_pass",
        details:
          job.stage_status === "queued"
            ? "Queued deck-level authority translation."
            : "Running deck-level authority translation and downstream delivery.",
      };
    case "finalize":
      return {
        progress_percent: 95,
        current_step: "finalize",
        details: "Finalizing translation results.",
      };
    default:
      return {
        progress_percent: 0,
        current_step: job.status,
        details: undefined,
      };
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function buildJobStatusResponse(
  job: JobRow,
  slideResults: readonly JobSlideResult[] = [],
  progress?: Record<string, string>
): JobStatusResponse {
  if (job.status === "completed" || job.status === "completed_with_warnings") {
    const normalizedWarnings = mergeWarningsWithSlideResults(
      normalizeWarnings(job.warnings),
      slideResults
    );
    const slideSummary = summarizeTerminalSlideResults(slideResults);
    const response: JobCompletedResponse = {
      job_id: job.id,
      status: job.status,
      progress_percent: 100,
      output_document_url: job.output_document_url ?? "",
      message: buildCompletedMessage(normalizedWarnings, slideSummary, slideResults),
      fully_delivered_body_slide_indices: slideSummary.fully_delivered_body_slide_indices,
      content_only_slide_indices: slideSummary.content_only_slide_indices,
      notes_only_slide_indices: slideSummary.notes_only_slide_indices,
      body_partial_slide_indices: slideSummary.body_partial_slide_indices,
      skipped_slide_indices: slideSummary.skipped_slide_indices,
      refunded_slide_indices: slideSummary.refunded_slide_indices,
      total_billed_units: job.total_units_billed,
      gross_billed_slides: job.gross_billed_slides,
      refunded_slides: job.refunded_slides,
      net_billed_slides: job.net_billed_slides,
      ...(normalizedWarnings.length > 0 ? { warnings: normalizedWarnings } : {}),
    };
    return response;
  }

  if (job.status === "failed") {
    const normalizedWarnings = mergeWarningsWithSlideResults(
      normalizeWarnings(job.warnings),
      slideResults
    );
    const slideSummary = summarizeTerminalSlideResults(slideResults);
    const response: JobFailedResponse = {
      job_id: job.id,
      status: "failed",
      error: job.error_code ?? "JOB_INTERNAL_ERROR",
      message: buildFailedMessage(job.error_message ?? "Translation failed.", normalizedWarnings, slideSummary, slideResults),
      output_document_url: job.output_document_url ?? undefined,
      total_billed_units: job.total_units_billed,
      gross_billed_slides: job.gross_billed_slides,
      refunded_slides: job.refunded_slides,
      net_billed_slides: job.net_billed_slides,
      ...(slideSummary.fully_delivered_body_slide_indices.length > 0
        ? { fully_delivered_body_slide_indices: slideSummary.fully_delivered_body_slide_indices }
        : {}),
      ...(slideSummary.content_only_slide_indices.length > 0
        ? { content_only_slide_indices: slideSummary.content_only_slide_indices }
        : {}),
      ...(slideSummary.notes_only_slide_indices.length > 0
        ? { notes_only_slide_indices: slideSummary.notes_only_slide_indices }
        : {}),
      ...(slideSummary.body_partial_slide_indices.length > 0
        ? { body_partial_slide_indices: slideSummary.body_partial_slide_indices }
        : {}),
      ...(slideSummary.skipped_slide_indices.length > 0
        ? { skipped_slide_indices: slideSummary.skipped_slide_indices }
        : {}),
      ...(slideSummary.refunded_slide_indices.length > 0
        ? { refunded_slide_indices: slideSummary.refunded_slide_indices }
        : {}),
      ...(normalizedWarnings.length > 0 ? { warnings: normalizedWarnings } : {}),
    };
    return response;
  }

  if (job.status === "canceled") {
    const response: JobCanceledResponse = {
      job_id: job.id,
      status: "canceled",
      message: buildCanceledMessage(job),
      total_units_billed: job.net_billed_slides,
      output_mode: job.output_mode,
      output_document_url: job.output_document_url ?? undefined,
    };
    return response;
  }

  const redisStatus = progress?.status;
  const resolvedStatus: JobStatus = (redisStatus && isValidJobStatus(redisStatus))
    ? redisStatus
    : job.status;
  const synthesizedProgress = buildSynthesizedProgress(job);

  const response: JobProgressResponse = {
    job_id: job.id,
    status: resolvedStatus as JobInProgressStatus,
    progress_percent: progress?.progress_percent
      ? parseInt(progress.progress_percent, 10)
      : synthesizedProgress.progress_percent,
    translated_units_billed: job.provisionally_billed_units,
    ...(job.current_stage ? { current_stage: job.current_stage } : {}),
    ...(job.stage_status ? { stage_status: job.stage_status } : {}),
    ...(job.stage_attempt > 0 ? { stage_attempt: job.stage_attempt } : {}),
    ...((progress?.current_step ?? synthesizedProgress.current_step)
      ? { current_step: progress?.current_step ?? synthesizedProgress.current_step }
      : {}),
    ...((progress?.details ?? synthesizedProgress.details)
      ? { details: progress?.details ?? synthesizedProgress.details }
      : {}),
  };

  return response;
}

export function __buildJobStatusResponseForTests(
  job: JobRow,
  slideResults: readonly JobSlideResult[] = [],
  progress?: Record<string, string>
): JobStatusResponse {
  return buildJobStatusResponse(job, slideResults, progress);
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
      await updateJobStatus(pool, jobId, "queued", {
        currentStage: "extract",
        stageStatus: "queued",
        stageAttempt: 1,
        queuedTaskName: null,
      });
      const queuedTaskName = await enqueueJob(config, jobId, "extract", 1);
      await updateJobStatus(pool, jobId, "queued", {
        queuedTaskName,
      });
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
      const slideResults = await listJobSlideResults(pool, job.id, auth.user_id);
      res.json(buildJobStatusResponse(job, slideResults));
      return;
    }

    const progress = await redis.hgetall(`job_progress:${job.id}`);
    res.json(buildJobStatusResponse(job, [], progress));
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
      await deleteQueuedJob(config, job.queued_task_name);
      await updateJobStatus(pool, job.id, "canceled", {
        currentStage: null,
        stageStatus: null,
        stageLeaseExpiresAt: null,
        stageLastHeartbeatAt: null,
        queuedTaskName: null,
      });
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
