import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import { kmsEncrypt } from "@translay/shared-config/dist/kms";
import type {
  CreateJobRequest,
  CreateJobResponse,
  CancelJobResponse,
  JobCanceledResponse,
  JobCompletedResponse,
  JobFailedResponse,
  JobLiveStatus,
  JobPauseStatus,
  JobProgressResponse,
  JobInProgressStatus,
  JobId,
  HostType,
  JobSlideResult,
  JobStatus,
  JobStatusResponse,
  PauseJobResponse,
  ResumeJobResponse,
  JobWarning,
  JobQuotaPartialOption,
  JobQuotaPreviewResponse,
  JobDriveCleanupSnapshot,
  RangeMode,
  UserId,
  DriveCleanupStatus,
  DriveCleanupRetryResponse,
} from "@translay/shared-contracts";
import {
  validateCreateJobRequest,
  matchPresetLanguage,
  billingPeriodKey,
  buildJobCancelKey,
  buildJobPauseKey,
  getRemainingQuota,
  computeEntitlement,
  FREE_TIER_MAX_JOBS_PER_PERIOD,
  parsePageRange,
  truncateSlideRangeExpressionToQuota,
} from "@translay/shared-domain";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { getUsageSummary } from "../../repositories/usage-repo";
import { getCreditBalance } from "../../repositories/credit-repo";
import {
  acquireCreateJobAdmission,
  createJob,
  findUnresolvedDriveCleanupJobForSource,
  getJobById,
  hasRunningJob,
  recordDriveCleanupRetryResult,
  hasCompletedEquivalentJob,
  sweepExpiredHostOauthTokens,
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
const PAUSE_KEY_TTL_SECONDS = 24 * 60 * 60;
const HOST_OAUTH_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const MAX_HOST_OAUTH_TOKEN_BYTES = 8 * 1024;
const HOST_OAUTH_SWEEP_GRACE_PERIOD_MINUTES = 60;
const HOST_OAUTH_SWEEP_BATCH_LIMIT = 500;
const PREPARED_DRIVE_CLEANUP_TTL_SECONDS = 24 * 60 * 60;
const UNRESOLVED_DRIVE_CLEANUP_MESSAGE =
  "A previous request for this presentation still has pending temporary access cleanup.";
const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const DRIVE_PERMISSION_DELETE_TIMEOUT_MS = 10_000;
const DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS = [500, 1_000] as const;

type ResolvedHostOauthPersistence = {
  readonly encryptedHostOauthToken: Buffer | null;
  readonly hostOauthTokenExpiresAt: Date | null;
  readonly hostOauthSource: "addon" | "sa_fallback";
};

type PreparedDriveCleanupRecord = {
  readonly source_doc_id: string;
  readonly source_worker_permission_id: string | null;
  readonly target_doc_id: string | null;
  readonly target_worker_permission_id: string | null;
  readonly target_was_copied_by_addon: boolean;
  readonly drive_cleanup_attempts: number;
  readonly drive_cleanup_last_error_code: string | null;
  readonly registered_at: string;
};

function isLikelyJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (token.length === 0 || token.length > MAX_HOST_OAUTH_TOKEN_BYTES) {
    return null;
  }
  return token;
}

function extractDriveAccessToken(authorizationHeader: string | undefined): string | null {
  const token = extractBearerToken(authorizationHeader);
  if (!token || isLikelyJwt(token)) {
    return null;
  }
  return token;
}

async function resolveHostOauthPersistence(
  authorizationHeader: string | undefined,
  options: {
    readonly encrypt?: typeof kmsEncrypt;
    readonly nowMs?: () => number;
    readonly onEncryptError?: (error: unknown) => void;
  } = {}
): Promise<ResolvedHostOauthPersistence | null> {
  const rawHostOauthToken = extractDriveAccessToken(authorizationHeader);
  if (!rawHostOauthToken) {
    return null;
  }

  const encrypt = options.encrypt ?? kmsEncrypt;
  const now = options.nowMs ?? (() => Date.now());
  try {
    const encryptedHostOauthToken = await encrypt(rawHostOauthToken);
    return {
      encryptedHostOauthToken,
      hostOauthTokenExpiresAt: new Date(now() + HOST_OAUTH_TOKEN_LIFETIME_MS),
      hostOauthSource: "addon",
    };
  } catch (error) {
    options.onEncryptError?.(error);
    return {
      encryptedHostOauthToken: null,
      hostOauthTokenExpiresAt: null,
      hostOauthSource: "sa_fallback",
    };
  }
}

function isInternalCronAuthorized(
  authorizationHeader: string | undefined,
  config: AppConfig
): boolean {
  const secret = config.security.internalCronSecret;
  if (!secret) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorizationHeader ?? "");
  if (expected.length !== received.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, received);
}

// S8: Validate a string is a known job status
function isValidJobStatus(s: string): s is JobStatus {
  return (
    s === "pending" || s === "queued" || s === "extracting" ||
    s === "translating" || s === "writing" || s === "completed" ||
    s === "completed_with_warnings" ||
    s === "failed" || s === "canceled"
  );
}

function isValidJobLiveStatus(s: string): s is JobLiveStatus | JobStatus {
  return isValidJobStatus(s) || s === "pausing" || s === "paused";
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

function isRunningLiveStatus(status: string | null | undefined): status is JobInProgressStatus {
  return (
    status === "pending" ||
    status === "queued" ||
    status === "extracting" ||
    status === "translating" ||
    status === "writing"
  );
}

function initialDriveCleanupStatus(body: CreateJobRequest): DriveCleanupStatus {
  return body.drive_access?.source_worker_permission_id ||
    body.drive_access?.target_worker_permission_id
    ? "pending"
    : "not_required";
}

function hasUnresolvedDriveCleanup(job: JobRow): boolean {
  return (
    (job.source_worker_permission_id !== null || job.target_worker_permission_id !== null) &&
    (job.drive_cleanup_status === "pending" || job.drive_cleanup_status === "failed")
  );
}

type DriveCleanupRetryStatus = DriveCleanupRetryResponse["drive_cleanup_status"];

type DriveCleanupTarget = {
  readonly fileId: string;
  readonly permissionId: string;
};

type DriveCleanupFileTrashTarget = {
  readonly fileId: string;
};

type FetchLike = typeof fetch;

type DriveCleanupRetryHooks = {
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_SLEEP = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let driveCleanupFetch: FetchLike = fetch;
let driveCleanupSleep = DEFAULT_SLEEP;

function buildDriveCleanupTargets(job: JobRow): DriveCleanupTarget[] {
  const targets: DriveCleanupTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (fileId: string | null, permissionId: string | null) => {
    if (!fileId || !permissionId) {
      return;
    }
    const key = `${fileId}:${permissionId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ fileId, permissionId });
  };

  if (job.source_worker_permission_id) {
    addTarget(job.source_doc_id, job.source_worker_permission_id);
  }
  addTarget(job.target_doc_id, job.target_worker_permission_id);
  return targets;
}

function buildPreparedDriveCleanupTargets(record: PreparedDriveCleanupRecord): DriveCleanupTarget[] {
  const targets: DriveCleanupTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (fileId: string | null, permissionId: string | null) => {
    if (!fileId || !permissionId) {
      return;
    }
    const key = `${fileId}:${permissionId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ fileId, permissionId });
  };

  addTarget(record.source_doc_id, record.source_worker_permission_id);
  addTarget(record.target_doc_id, record.target_worker_permission_id);
  return targets;
}

function buildPreparedDriveTrashTarget(record: PreparedDriveCleanupRecord): DriveCleanupFileTrashTarget | null {
  if (!record.target_doc_id || !record.target_was_copied_by_addon) {
    return null;
  }
  return { fileId: record.target_doc_id };
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return (
    status === "completed" ||
    status === "completed_with_warnings" ||
    status === "failed" ||
    status === "canceled" ||
    status === "rolled_back"
  );
}

function buildDriveCleanupRetryResponse(
  job: JobRow | null,
  message: string
): DriveCleanupRetryResponse {
  const status = normalizeDriveCleanupRetryStatus(job?.drive_cleanup_status ?? null);
  return {
    job_id: job?.id ?? null,
    drive_cleanup_status: status,
    drive_cleanup_attempts: job?.drive_cleanup_attempts ?? 0,
    ...(job?.drive_cleanup_last_error_code
      ? { drive_cleanup_last_error_code: job.drive_cleanup_last_error_code }
      : {}),
    message,
  };
}

function buildPreparedDriveCleanupKey(userId: UserId, sourceDocId: string): string {
  return `jobs:prepared-drive-cleanup:${userId}:${sourceDocId}`;
}

function parsePreparedDriveCleanupRecord(raw: string | null): PreparedDriveCleanupRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<PreparedDriveCleanupRecord>;
    if (typeof value.source_doc_id !== "string" || value.source_doc_id.trim().length === 0) {
      return null;
    }
    return {
      source_doc_id: value.source_doc_id.trim(),
      source_worker_permission_id:
        typeof value.source_worker_permission_id === "string" && value.source_worker_permission_id.trim().length > 0
          ? value.source_worker_permission_id.trim()
          : null,
      target_doc_id:
        typeof value.target_doc_id === "string" && value.target_doc_id.trim().length > 0
          ? value.target_doc_id.trim()
          : null,
      target_worker_permission_id:
        typeof value.target_worker_permission_id === "string" && value.target_worker_permission_id.trim().length > 0
          ? value.target_worker_permission_id.trim()
          : null,
      target_was_copied_by_addon: value.target_was_copied_by_addon === true,
      drive_cleanup_attempts:
        typeof value.drive_cleanup_attempts === "number" && value.drive_cleanup_attempts >= 0
          ? Math.floor(value.drive_cleanup_attempts)
          : 0,
      drive_cleanup_last_error_code:
        typeof value.drive_cleanup_last_error_code === "string" && value.drive_cleanup_last_error_code.length > 0
          ? value.drive_cleanup_last_error_code
          : null,
      registered_at:
        typeof value.registered_at === "string" && value.registered_at.length > 0
          ? value.registered_at
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function getPreparedDriveCleanupRecord(
  redis: Redis,
  userId: UserId,
  sourceDocId: string
): Promise<PreparedDriveCleanupRecord | null> {
  return parsePreparedDriveCleanupRecord(
    await redis.get(buildPreparedDriveCleanupKey(userId, sourceDocId))
  );
}

async function deletePreparedDriveCleanupRecord(
  redis: Redis,
  userId: UserId,
  sourceDocId: string
): Promise<void> {
  await redis.del(buildPreparedDriveCleanupKey(userId, sourceDocId));
}

async function setPreparedDriveCleanupRecord(
  redis: Redis,
  userId: UserId,
  record: PreparedDriveCleanupRecord
): Promise<void> {
  await redis.set(
    buildPreparedDriveCleanupKey(userId, record.source_doc_id),
    JSON.stringify(record),
    "EX",
    PREPARED_DRIVE_CLEANUP_TTL_SECONDS
  );
}

function buildDriveCleanupSnapshot(job: JobRow): JobDriveCleanupSnapshot {
  if (job.drive_cleanup_status !== "pending" && job.drive_cleanup_status !== "failed") {
    return {};
  }
  return {
    drive_cleanup_status: job.drive_cleanup_status,
    drive_cleanup_attempts: job.drive_cleanup_attempts,
    ...(job.drive_cleanup_last_error_code
      ? { drive_cleanup_last_error_code: job.drive_cleanup_last_error_code }
      : {}),
  };
}

function preparedCleanupMatchesCreateJob(
  record: PreparedDriveCleanupRecord,
  body: CreateJobRequest
): boolean {
  return (
    record.source_doc_id === body.document_id &&
    record.source_worker_permission_id === (body.drive_access?.source_worker_permission_id ?? null) &&
    record.target_doc_id === (body.target_document_id ?? null) &&
    record.target_worker_permission_id === (body.drive_access?.target_worker_permission_id ?? null)
  );
}

function normalizeDriveCleanupRetryStatus(
  status: DriveCleanupStatus | null
): DriveCleanupRetryStatus {
  if (status === "succeeded" || status === "not_required") {
    return status;
  }
  if (status === "pending" || status === "failed") {
    return "failed";
  }
  return "not_required";
}

function createDriveCleanupHttpError(status: number): Error {
  const error = new Error(`Drive permission cleanup failed with HTTP ${status}`);
  (error as { status?: number }).status = status;
  return error;
}

async function fetchDrivePermissionDelete(
  accessToken: string,
  target: DriveCleanupTarget
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRIVE_PERMISSION_DELETE_TIMEOUT_MS);
  try {
    const response = await driveCleanupFetch(
      `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(target.fileId)}` +
        `/permissions/${encodeURIComponent(target.permissionId)}?supportsAllDrives=true`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      }
    );
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw createDriveCleanupHttpError(response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDriveFileTrash(
  accessToken: string,
  target: DriveCleanupFileTrashTarget
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRIVE_PERMISSION_DELETE_TIMEOUT_MS);
  try {
    const response = await driveCleanupFetch(
      `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(target.fileId)}?supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trashed: true }),
        signal: controller.signal,
      }
    );
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw createDriveCleanupHttpError(response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteDrivePermissionWithRetry(
  accessToken: string,
  target: DriveCleanupTarget
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fetchDrivePermissionDelete(accessToken, target);
      return;
    } catch (error) {
      if (extractDriveCleanupErrorStatus(error) === 404) {
        return;
      }
      lastError = error;
      const retryDelayMs = DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableDriveCleanupError(error)) {
        break;
      }
      await driveCleanupSleep(retryDelayMs);
    }
  }
  throw lastError;
}

async function trashDriveFileWithRetry(
  accessToken: string,
  target: DriveCleanupFileTrashTarget
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fetchDriveFileTrash(accessToken, target);
      return;
    } catch (error) {
      if (extractDriveCleanupErrorStatus(error) === 404) {
        return;
      }
      lastError = error;
      const retryDelayMs = DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableDriveCleanupError(error)) {
        break;
      }
      await driveCleanupSleep(retryDelayMs);
    }
  }
  throw lastError;
}

async function retryDriveCleanupWithFreshToken(
  pool: Pool,
  job: JobRow,
  accessToken: string
): Promise<DriveCleanupRetryResponse> {
  if (job.drive_cleanup_status === "succeeded") {
    return buildDriveCleanupRetryResponse(job, "Temporary access cleanup already succeeded.");
  }
  if (job.drive_cleanup_status === "not_required") {
    return buildDriveCleanupRetryResponse(job, "No temporary access cleanup is required.");
  }

  const targets = buildDriveCleanupTargets(job);
  if (targets.length === 0) {
    const updated = await recordDriveCleanupRetryResult(pool, {
      jobId: job.id,
      userId: job.user_id as UserId,
      status: "not_required",
      errorCode: null,
    });
    return buildDriveCleanupRetryResponse(
      updated,
      "No temporary access cleanup is required."
    );
  }

  let firstErrorCode: string | null = null;
  for (const target of targets) {
    try {
      await deleteDrivePermissionWithRetry(accessToken, target);
    } catch (error) {
      firstErrorCode ??= normalizeDriveCleanupErrorCode(error);
    }
  }

  const status: DriveCleanupRetryStatus = firstErrorCode ? "failed" : "succeeded";
  const updated = await recordDriveCleanupRetryResult(pool, {
    jobId: job.id,
    userId: job.user_id as UserId,
    status,
    errorCode: firstErrorCode,
  });

  return buildDriveCleanupRetryResponse(
    updated,
    status === "succeeded"
      ? "Temporary access cleanup succeeded."
      : "Temporary access cleanup is still pending. Please retry or contact support with the task ID."
  );
}

async function retryPreparedDriveCleanupWithFreshToken(
  redis: Redis,
  userId: UserId,
  record: PreparedDriveCleanupRecord,
  accessToken: string
): Promise<DriveCleanupRetryResponse> {
  const permissionTargets = buildPreparedDriveCleanupTargets(record);
  const trashTarget = buildPreparedDriveTrashTarget(record);

  if (permissionTargets.length === 0 && !trashTarget) {
    await deletePreparedDriveCleanupRecord(redis, userId, record.source_doc_id);
    return {
      job_id: null,
      drive_cleanup_status: "not_required",
      drive_cleanup_attempts: record.drive_cleanup_attempts,
      message: "No temporary access cleanup is required.",
    };
  }

  let firstErrorCode: string | null = null;
  for (const target of permissionTargets) {
    try {
      await deleteDrivePermissionWithRetry(accessToken, target);
    } catch (error) {
      firstErrorCode ??= normalizeDriveCleanupErrorCode(error);
    }
  }

  if (trashTarget) {
    try {
      await trashDriveFileWithRetry(accessToken, trashTarget);
    } catch (error) {
      firstErrorCode ??= normalizeDriveCleanupErrorCode(error);
    }
  }

  const attempts = record.drive_cleanup_attempts + 1;
  if (!firstErrorCode) {
    await deletePreparedDriveCleanupRecord(redis, userId, record.source_doc_id);
    return {
      job_id: null,
      drive_cleanup_status: "succeeded",
      drive_cleanup_attempts: attempts,
      message: "Temporary access cleanup succeeded.",
    };
  }

  await setPreparedDriveCleanupRecord(redis, userId, {
    ...record,
    drive_cleanup_attempts: attempts,
    drive_cleanup_last_error_code: firstErrorCode,
  });
  return {
    job_id: null,
    drive_cleanup_status: "failed",
    drive_cleanup_attempts: attempts,
    drive_cleanup_last_error_code: firstErrorCode,
    message: "Temporary access cleanup is still pending. Please retry or contact support.",
  };
}

function normalizeDriveCleanupErrorCode(error: unknown): string {
  const status = extractDriveCleanupErrorStatus(error);
  if (status === 401) {
    return "drive_cleanup_unauthorized";
  }
  if (status === 403) {
    return "drive_cleanup_forbidden";
  }
  if (status === 404) {
    return "drive_permission_not_found";
  }
  if (status === 429) {
    return "drive_cleanup_rate_limited";
  }
  if (status !== null && status >= 500) {
    return "drive_cleanup_api_unavailable";
  }
  const transportCode = extractDriveCleanupTransportCode(error);
  if (transportCode && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE/i.test(transportCode)) {
    return "drive_cleanup_network_error";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "drive_cleanup_network_error";
  }
  return "drive_permission_delete_failed";
}

function isRetryableDriveCleanupError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  const status = extractDriveCleanupErrorStatus(error);
  if (status !== null) {
    return status === 429 || status >= 500;
  }
  const transportCode = extractDriveCleanupTransportCode(error);
  return Boolean(
    transportCode &&
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE/i.test(transportCode)
  );
}

function extractDriveCleanupErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as {
    status?: unknown;
    response?: {
      status?: unknown;
      data?: {
        error?: {
          code?: unknown;
        };
      };
    };
  };
  for (const value of [
    candidate.status,
    candidate.response?.status,
    candidate.response?.data?.error?.code,
  ]) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  return null;
}

function extractDriveCleanupTransportCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isPauseStatus(status: string | undefined): status is JobPauseStatus {
  return status === "pausing" || status === "paused";
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

function hasPartialSuccess(
  summary: TerminalSlideSummary,
  warnings: readonly JobWarning[]
): boolean {
  const excludedSlides = new Set(listExcludedSlides(warnings));
  const deliveryFailureSlides = summary.skipped_slide_indices.filter(
    (slideNumber) => !excludedSlides.has(slideNumber)
  );
  return (
    summary.content_only_slide_indices.length > 0 ||
    summary.notes_only_slide_indices.length > 0 ||
    summary.body_partial_slide_indices.length > 0 ||
    deliveryFailureSlides.length > 0
  );
}

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
  slideSummary: TerminalSlideSummary,
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

function readProgressStatus(progress?: Record<string, string>): JobLiveStatus | JobStatus | null {
  const status = progress?.status;
  if (!status || !isValidJobLiveStatus(status)) {
    return null;
  }
  return status;
}

function buildPausedProgressResponse(
  job: JobRow,
  progress: Record<string, string> | undefined,
  status: JobPauseStatus
): JobProgressResponse {
  const synthesizedProgress = buildSynthesizedProgress(job);
  const progressPercent = progress?.progress_percent
    ? parseInt(progress.progress_percent, 10)
    : synthesizedProgress.progress_percent;
  return {
    job_id: job.id,
    status,
    progress_percent: Number.isFinite(progressPercent) ? progressPercent : synthesizedProgress.progress_percent,
    translated_units_billed: job.provisionally_billed_units,
    ...(job.current_stage ? { current_stage: job.current_stage } : {}),
    ...(job.stage_status ? { stage_status: job.stage_status } : {}),
    ...(job.stage_attempt > 0 ? { stage_attempt: job.stage_attempt } : {}),
    ...((progress?.current_step ?? (status === "paused" ? "paused" : "pausing"))
      ? { current_step: progress?.current_step ?? (status === "paused" ? "paused" : "pausing") }
      : {}),
    ...((progress?.details ??
      (status === "paused"
        ? "Translation paused. Confirm cancellation or continue to resume."
        : "Pause requested. The worker will pause at the next safe checkpoint."))
      ? {
          details:
            progress?.details ??
            (status === "paused"
              ? "Translation paused. Confirm cancellation or continue to resume."
              : "Pause requested. The worker will pause at the next safe checkpoint."),
        }
      : {}),
  };
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

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]);
    return Object.fromEntries(sortedEntries);
  }

  return value;
}

function stableRequestFingerprint(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex");
}

function buildJobStatusResponse(
  job: JobRow,
  slideResults: readonly JobSlideResult[] = [],
  progress?: Record<string, string>
): JobStatusResponse {
  if (job.status === "completed" || job.status === "completed_with_warnings") {
    if (!job.output_document_url) {
      const response: JobFailedResponse = {
        job_id: job.id,
        status: "failed",
        error: "JOB_INTERNAL_ERROR",
        message: "Translation finished without an output document URL.",
        total_billed_units: job.total_units_billed,
        gross_billed_slides: job.gross_billed_slides,
        refunded_slides: job.refunded_slides,
        net_billed_slides: job.net_billed_slides,
        ...buildDriveCleanupSnapshot(job),
      };
      return response;
    }
    const normalizedWarnings = mergeWarningsWithSlideResults(
      normalizeWarnings(job.warnings),
      slideResults
    );
    const slideSummary = summarizeTerminalSlideResults(slideResults);
    const completionCode = hasPartialSuccess(slideSummary, normalizedWarnings)
      ? "PARTIAL_SUCCESS"
      : undefined;
    const response: JobCompletedResponse = {
      job_id: job.id,
      status: completionCode ? "completed_with_warnings" : job.status,
      progress_percent: 100,
      output_document_url: job.output_document_url,
      message: buildCompletedMessage(normalizedWarnings, slideSummary, slideResults),
      ...(completionCode ? { completion_code: completionCode } : {}),
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
      ...buildDriveCleanupSnapshot(job),
      ...(normalizedWarnings.length > 0 ? { warnings: normalizedWarnings } : {}),
    };
    return response;
  }

  if (job.status === "failed" || job.status === "rolled_back") {
    const normalizedWarnings = mergeWarningsWithSlideResults(
      normalizeWarnings(job.warnings),
      slideResults
    );
    const slideSummary = summarizeTerminalSlideResults(slideResults);
    const response: JobFailedResponse = {
      job_id: job.id,
      status: "failed",
      error: job.error_code ?? "JOB_INTERNAL_ERROR",
      message: buildFailedMessage(
        job.error_message ??
          (job.status === "rolled_back"
            ? "Translation output was rolled back."
            : "Translation failed."),
        normalizedWarnings,
        slideSummary,
        slideResults
      ),
      output_document_url: job.output_document_url ?? undefined,
      total_billed_units: job.total_units_billed,
      gross_billed_slides: job.gross_billed_slides,
      refunded_slides: job.refunded_slides,
      net_billed_slides: job.net_billed_slides,
      ...buildDriveCleanupSnapshot(job),
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
      ...buildDriveCleanupSnapshot(job),
    };
    return response;
  }

  const liveStatus = readProgressStatus(progress);
  if (liveStatus === "paused" || liveStatus === "pausing") {
    return buildPausedProgressResponse(job, progress, liveStatus);
  }

  const resolvedStatus: JobStatus = isRunningLiveStatus(liveStatus)
    ? liveStatus
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

type SlidesQuotaRequest = {
  readonly host_type: HostType;
  readonly document_id: string;
  readonly range_mode: RangeMode;
  readonly range_expression?: string | null;
};

function resolveSlidesRangeExpression(body: SlidesQuotaRequest): string | null {
  if (body.host_type !== "slides") {
    return null;
  }
  if (body.range_mode === "custom" && body.range_expression) {
    return body.range_expression;
  }
  if (body.range_mode === "current" && body.range_expression) {
    return body.range_expression;
  }
  return null;
}

function buildQuotaPartialOption(
  rangeExpression: string,
  availableUnits: number
): JobQuotaPartialOption | null {
  const truncated = truncateSlideRangeExpressionToQuota(rangeExpression, availableUnits);
  if (!truncated || truncated.allowed_indices.length === 0 || truncated.excluded_indices.length === 0) {
    return null;
  }

  return {
    ok: false,
    error: "QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION",
    message: "Usage quota is insufficient, but part of the selected Slides range can continue",
    required_units: truncated.required_units,
    available_units: truncated.allowed_indices.length,
    allowed_range_expression: truncated.allowed_range_expression,
    excluded_range_expression: truncated.excluded_range_expression,
    cta: {
      upgrade_subscription: true,
      buy_credits: true,
    },
  };
}

function previewSlidesQuota(
  body: SlidesQuotaRequest,
  availableUnits: number
): JobQuotaPreviewResponse | null {
  const rangeExpression = resolveSlidesRangeExpression(body);
  if (!rangeExpression) {
    return null;
  }

  const selected = parsePageRange(rangeExpression);
  if (!selected) {
    return null;
  }

  if (!Number.isFinite(availableUnits) || selected.length <= availableUnits) {
    return {
      ok: true,
      required_units: selected.length,
      available_units: Number.isFinite(availableUnits)
        ? Math.max(0, Math.floor(availableUnits))
        : selected.length,
      accepted_range_expression: rangeExpression,
    };
  }

  return buildQuotaPartialOption(rangeExpression, availableUnits);
}

function validateJobPreviewRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return "request body must be an object";
  }
  const req = body as Partial<SlidesQuotaRequest>;
  if (req.host_type !== "slides") {
    return "quota partial preview is currently supported for Slides only";
  }
  if (typeof req.document_id !== "string" || req.document_id.trim().length === 0) {
    return "document_id is required";
  }
  if (req.range_mode !== "custom" && req.range_mode !== "current") {
    return "Slides quota preview requires an explicit range";
  }
  if (!req.range_expression || typeof req.range_expression !== "string") {
    return "range_expression is required";
  }
  if (!parsePageRange(req.range_expression)) {
    return "Invalid range expression";
  }
  return null;
}

async function getEntitledUsageSnapshot(pool: Pool, userId: string) {
  const sub = await getActiveSubscription(pool, userId as UserId);
  if (!sub) {
    return { error: "Subscription state is not initialized" as const };
  }

  const entitlement = computeEntitlement({
    plan_type: sub.plan_type,
    subscription_status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    current_period_end: sub.current_period_end,
  });

  if (!entitlement.active) {
    return { error: "inactive" as const };
  }

  const periodKey = billingPeriodKey();
  const usage = await getUsageSummary(pool, userId as UserId, periodKey);
  const credits = await getCreditBalance(pool, userId as UserId);
  return { sub, usage, credits };
}

export function previewJobHandler(pool: Pool, redis: Redis) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const validationError = validateJobPreviewRequest(req.body);
    if (validationError) {
      sendError(res, "VALIDATION_ERROR", validationError);
      return;
    }

    const body = req.body as SlidesQuotaRequest;
    const unresolvedCleanupJob = await findUnresolvedDriveCleanupJobForSource(pool, {
      userId: auth.user_id,
      sourceDocId: body.document_id.trim(),
    });
    if (unresolvedCleanupJob && hasUnresolvedDriveCleanup(unresolvedCleanupJob)) {
      res.status(409).json({
        error: "DRIVE_CLEANUP_REQUIRED",
        message: UNRESOLVED_DRIVE_CLEANUP_MESSAGE,
      });
      return;
    }
    const preparedCleanup = await getPreparedDriveCleanupRecord(
      redis,
      auth.user_id,
      body.document_id.trim()
    );
    if (preparedCleanup) {
      res.status(409).json({
        error: "DRIVE_CLEANUP_REQUIRED",
        message: UNRESOLVED_DRIVE_CLEANUP_MESSAGE,
      });
      return;
    }

    const snapshot = await getEntitledUsageSnapshot(pool, auth.user_id);
    if ("error" in snapshot && snapshot.error === "Subscription state is not initialized") {
      sendError(res, "ACCESS_DENIED", "Subscription state is not initialized");
      return;
    }
    if ("error" in snapshot) {
      sendError(res, "ACCESS_DENIED");
      return;
    }

    const { sub, usage, credits } = snapshot;
    if (
      sub.plan_type === "free" &&
      usage.total_jobs >= FREE_TIER_MAX_JOBS_PER_PERIOD &&
      credits.slides_balance <= 0
    ) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }

    const planRemaining = getRemainingQuota(
      sub.plan_type,
      "slides",
      getHostUsed(usage, "slides")
    );
    const remaining = planRemaining + credits.slides_balance;
    if (Number.isFinite(remaining) && remaining <= 0) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }

    const preview = previewSlidesQuota(body, remaining);
    if (!preview) {
      sendError(res, "VALIDATION_ERROR", "Invalid range expression");
      return;
    }

    res.status(200).json(preview);
  };
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
      if (existingJob && hasUnresolvedDriveCleanup(existingJob)) {
        sendError(
          res,
          "DRIVE_CLEANUP_REQUIRED",
          UNRESOLVED_DRIVE_CLEANUP_MESSAGE
        );
        return;
      }
      await deleteIdempotencyRecord(pool, auth.user_id, body.idempotency_key);
    }

    const unresolvedCleanupJob = await findUnresolvedDriveCleanupJobForSource(pool, {
      userId: auth.user_id,
      sourceDocId: body.document_id,
    });
    if (unresolvedCleanupJob) {
      sendError(res, "DRIVE_CLEANUP_REQUIRED", UNRESOLVED_DRIVE_CLEANUP_MESSAGE);
      return;
    }
    const preparedCleanup = await getPreparedDriveCleanupRecord(
      redis,
      auth.user_id,
      body.document_id
    );
    if (preparedCleanup && !preparedCleanupMatchesCreateJob(preparedCleanup, body)) {
      sendError(res, "DRIVE_CLEANUP_REQUIRED", UNRESOLVED_DRIVE_CLEANUP_MESSAGE);
      return;
    }

    const running = await hasRunningJob(pool, auth.user_id);
    if (running) {
      sendError(res, "CONCURRENT_JOB_RUNNING");
      return;
    }

    const snapshot = await getEntitledUsageSnapshot(pool, auth.user_id);
    if ("error" in snapshot && snapshot.error === "Subscription state is not initialized") {
      sendError(res, "ACCESS_DENIED", "Subscription state is not initialized");
      return;
    }
    if ("error" in snapshot) {
      sendError(res, "ACCESS_DENIED");
      return;
    }
    const { sub, usage, credits } = snapshot;

    if (
      sub.plan_type === "free" &&
      usage.total_jobs >= FREE_TIER_MAX_JOBS_PER_PERIOD &&
      credits.slides_balance <= 0
    ) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }

    const creditBalance =
      body.host_type === "slides"
        ? credits.slides_balance
        : body.host_type === "docs"
          ? credits.docs_pages_balance
          : credits.sheets_cells_balance;
    const remaining =
      getRemainingQuota(sub.plan_type, body.host_type, getHostUsed(usage, body.host_type)) +
      creditBalance;
    if (Number.isFinite(remaining) && remaining <= 0) {
      sendError(res, "QUOTA_EXCEEDED");
      return;
    }
    const quotaPreview = previewSlidesQuota(body, remaining);
    if (quotaPreview && !quotaPreview.ok) {
      res.status(403).json(quotaPreview);
      return;
    }

    const targetLanguageCode = matchPresetLanguage(body.target_language_input);
    const hostOauthPersistence = await resolveHostOauthPersistence(req.headers.authorization, {
      onEncryptError: (error) => {
        console.warn(
          "[jobs] failed to persist host OAuth token, falling back to service account",
          JSON.stringify({
            user_id: auth.user_id,
            document_id: body.document_id,
            error_message: error instanceof Error ? error.message : String(error),
          })
        );
      },
    });
    if (!hostOauthPersistence) {
      sendError(res, "INVALID_TOKEN");
      return;
    }

    const client = await pool.connect();
    let jobId: JobId;
    let postAdmissionInFlightJobs = 0;
    try {
      await client.query("BEGIN");

      const admission = await acquireCreateJobAdmission(
        client,
        auth.user_id,
        config.jobs.maxGlobalInFlightJobs
      );
      if (!admission.allowed) {
        await client.query("ROLLBACK");
        if (admission.blockedBy === "user") {
          sendError(res, "CONCURRENT_JOB_RUNNING");
          return;
        }
        console.warn(
          "[jobs] queue busy",
          JSON.stringify({
            user_id: auth.user_id,
            global_inflight_jobs: admission.activeCount,
            max_global_inflight_jobs: config.jobs.maxGlobalInFlightJobs,
          })
        );
        sendError(res, "JOB_QUEUE_BUSY");
        return;
      }
      postAdmissionInFlightJobs = admission.activeCount + 1;

      jobId = await createJob(client, {
        userId: auth.user_id,
        hostType: body.host_type,
        sourceDocId: body.document_id,
        targetDocId: body.target_document_id ?? null,
        sourceWorkerPermissionId: body.drive_access?.source_worker_permission_id ?? null,
        targetWorkerPermissionId: body.drive_access?.target_worker_permission_id ?? null,
        driveCleanupStatus: initialDriveCleanupStatus(body),
        sourceLangMode: body.source_language_mode,
        targetLanguageInput: body.target_language_input,
        targetLanguageCode,
        outputMode: body.output_mode,
        rangeMode: body.range_mode,
        rangeExpression: body.range_expression ?? null,
        hostOauthAccessTokenEnc: hostOauthPersistence.encryptedHostOauthToken,
        hostOauthTokenExpiresAt: hostOauthPersistence.hostOauthTokenExpiresAt,
        hostOauthSource: hostOauthPersistence.hostOauthSource,
      });

      const fingerprint = stableRequestFingerprint(body);

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
        preserveHostOauthForCleanup: true,
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
    await deletePreparedDriveCleanupRecord(redis, auth.user_id, body.document_id);

    const response: CreateJobResponse = {
      status: "accepted",
      job_id: jobId,
      queued: true,
    };

    console.info(
      "[jobs] queued",
      JSON.stringify({
        job_id: jobId,
        user_id: auth.user_id,
        global_inflight_jobs: postAdmissionInFlightJobs,
        max_global_inflight_jobs: config.jobs.maxGlobalInFlightJobs,
      })
    );

    res.status(201).json(response);
  };
}

export function registerPreparedDriveCleanupHandler(redis: Redis) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const body = req.body as {
      document_id?: unknown;
      source_worker_permission_id?: unknown;
      target_document_id?: unknown;
      target_worker_permission_id?: unknown;
      target_was_copied_by_addon?: unknown;
    };
    if (!body || typeof body.document_id !== "string" || body.document_id.trim().length === 0) {
      sendError(res, "VALIDATION_ERROR", "document_id is required");
      return;
    }

    const record: PreparedDriveCleanupRecord = {
      source_doc_id: body.document_id.trim(),
      source_worker_permission_id:
        typeof body.source_worker_permission_id === "string" && body.source_worker_permission_id.trim().length > 0
          ? body.source_worker_permission_id.trim()
          : null,
      target_doc_id:
        typeof body.target_document_id === "string" && body.target_document_id.trim().length > 0
          ? body.target_document_id.trim()
          : null,
      target_worker_permission_id:
        typeof body.target_worker_permission_id === "string" && body.target_worker_permission_id.trim().length > 0
          ? body.target_worker_permission_id.trim()
          : null,
      target_was_copied_by_addon: body.target_was_copied_by_addon === true,
      drive_cleanup_attempts: 0,
      drive_cleanup_last_error_code: null,
      registered_at: new Date().toISOString(),
    };

    if (
      !record.source_worker_permission_id &&
      !record.target_worker_permission_id &&
      !record.target_doc_id
    ) {
      sendError(res, "VALIDATION_ERROR", "cleanup metadata is required");
      return;
    }

    await setPreparedDriveCleanupRecord(redis, auth.user_id, record);
    res.json({ status: "ok" });
  };
}

export function clearPreparedDriveCleanupHandler(redis: Redis) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const body = req.body as { document_id?: unknown };
    if (!body || typeof body.document_id !== "string" || body.document_id.trim().length === 0) {
      sendError(res, "VALIDATION_ERROR", "document_id is required");
      return;
    }

    await deletePreparedDriveCleanupRecord(redis, auth.user_id, body.document_id.trim());
    res.json({ status: "ok" });
  };
}

export function retryPendingDriveCleanupHandler(pool: Pool, redis: Redis) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const body = req.body as { document_id?: unknown };
    if (!body || typeof body.document_id !== "string" || body.document_id.trim().length === 0) {
      sendError(res, "VALIDATION_ERROR", "document_id is required");
      return;
    }

    const job = await findUnresolvedDriveCleanupJobForSource(pool, {
      userId: auth.user_id,
      sourceDocId: body.document_id.trim(),
    });
    const token = extractDriveAccessToken(req.headers.authorization);
    if (!token) {
      sendError(res, "INVALID_TOKEN");
      return;
    }

    if (!job) {
      const prepared = await getPreparedDriveCleanupRecord(redis, auth.user_id, body.document_id.trim());
      if (!prepared) {
        res.json({
          job_id: null,
          drive_cleanup_status: "not_required",
          drive_cleanup_attempts: 0,
          message: "No temporary access cleanup is pending for this presentation.",
        } satisfies DriveCleanupRetryResponse);
        return;
      }

      const preparedResponse = await retryPreparedDriveCleanupWithFreshToken(
        redis,
        auth.user_id,
        prepared,
        token
      );
      res.json(preparedResponse);
      return;
    }

    const response = await retryDriveCleanupWithFreshToken(pool, job, token);
    if (response.drive_cleanup_status === "succeeded" || response.drive_cleanup_status === "not_required") {
      await deletePreparedDriveCleanupRecord(redis, auth.user_id, body.document_id.trim());
    }
    res.json(response);
  };
}

export function retryJobDriveCleanupHandler(pool: Pool) {
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
    if (!isTerminalJobStatus(job.status)) {
      sendError(res, "VALIDATION_ERROR", "Temporary access cleanup can only be retried after a job reaches a terminal state.");
      return;
    }

    const token = extractDriveAccessToken(req.headers.authorization);
    if (!token) {
      sendError(res, "INVALID_TOKEN");
      return;
    }

    const response = await retryDriveCleanupWithFreshToken(pool, job, token);
    res.json(response);
  };
}

export function sweepHostOauthTokensHandler(pool: Pool, config: AppConfig) {
  return async (req: Request, res: Response) => {
    if (!config.security.internalCronSecret) {
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Internal cron secret is not configured.",
      });
      return;
    }

    if (!isInternalCronAuthorized(req.headers.authorization, config)) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const purgedJobs = await sweepExpiredHostOauthTokens(pool, {
      gracePeriodMinutes: HOST_OAUTH_SWEEP_GRACE_PERIOD_MINUTES,
      limit: HOST_OAUTH_SWEEP_BATCH_LIMIT,
    });
    res.json({
      status: "ok",
      purged_jobs: purgedJobs,
      grace_period_minutes: HOST_OAUTH_SWEEP_GRACE_PERIOD_MINUTES,
      batch_limit: HOST_OAUTH_SWEEP_BATCH_LIMIT,
    });
  };
}

export function __extractBearerTokenForTests(
  authorizationHeader: string | undefined
): string | null {
  return extractBearerToken(authorizationHeader);
}

export async function __resolveHostOauthPersistenceForTests(
  authorizationHeader: string | undefined,
  options?: {
    readonly encrypt?: typeof kmsEncrypt;
    readonly nowMs?: () => number;
    readonly onEncryptError?: (error: unknown) => void;
  }
): Promise<ResolvedHostOauthPersistence | null> {
  return resolveHostOauthPersistence(authorizationHeader, options);
}

export function __setDriveCleanupRetryHooksForTests(hooks: DriveCleanupRetryHooks): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive cleanup retry test hooks are disabled in production-like environments");
  }
  if (hooks.fetch) {
    driveCleanupFetch = hooks.fetch;
  }
  if (hooks.sleep) {
    driveCleanupSleep = hooks.sleep;
  }
}

export function __resetDriveCleanupRetryHooksForTests(): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive cleanup retry test hooks are disabled in production-like environments");
  }
  driveCleanupFetch = fetch;
  driveCleanupSleep = DEFAULT_SLEEP;
}

function isProductionLikeNodeEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
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
      job.status === "canceled" ||
      job.status === "rolled_back"
    ) {
      const slideResults = await listJobSlideResults(pool, job.id, auth.user_id);
      res.json(buildJobStatusResponse(job, slideResults));
      return;
    }

    const progress = await redis.hgetall(`job_progress:${job.id}`);
    res.json(buildJobStatusResponse(job, [], progress));
  };
}

export function pauseJobHandler(pool: Pool, redis: Redis, config: AppConfig) {
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
      const response: PauseJobResponse = {
        job_id: job.id,
        status: "already_completed",
        message: "This translation job has already completed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "failed" || job.status === "rolled_back") {
      const response: PauseJobResponse = {
        job_id: job.id,
        status: "already_failed",
        message:
          job.status === "rolled_back"
            ? "This translation job has already been rolled back."
            : "This translation job has already failed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "canceled") {
      const response: PauseJobResponse = {
        job_id: job.id,
        status: "already_canceled",
        message: buildCanceledMessage(job),
      };
      res.json(response);
      return;
    }

    const progressKey = `job_progress:${job.id}`;
    const progress = await redis.hgetall(progressKey);
    const liveStatus = readProgressStatus(progress);
    if (liveStatus === "paused") {
      const response: PauseJobResponse = {
        job_id: job.id,
        status: "paused",
        message: "Translation is already paused. Confirm cancellation or continue to resume.",
      };
      res.json(response);
      return;
    }

    const pauseKey = buildJobPauseKey(job.id);
    if (job.status === "pending" || job.status === "queued") {
      await deleteQueuedJob(config, job.queued_task_name);
      await updateJobStatus(pool, job.id, job.status, {
        stageAttempt: job.stage_attempt > 0 ? job.stage_attempt + 1 : 1,
        stageStatus: "queued",
        stageLeaseExpiresAt: null,
        stageLastHeartbeatAt: null,
        queuedTaskName: null,
      });

      const results = await redis
        .multi()
        .set(pauseKey, new Date().toISOString(), "EX", PAUSE_KEY_TTL_SECONDS)
        .del(buildJobCancelKey(job.id))
        .hset(progressKey, {
          status: "paused",
          progress_percent: progress.progress_percent || "0",
          current_step: "paused",
          details: "Translation paused before processing started. Confirm cancellation or continue to resume.",
        })
        .expire(progressKey, PAUSE_KEY_TTL_SECONDS)
        .exec();

      assertMultiOk(results, "jobs/pause queued progress");

      const response: PauseJobResponse = {
        job_id: job.id,
        status: "paused",
        message: "Translation paused before processing started.",
      };
      res.json(response);
      return;
    }

    const results = await redis
      .multi()
      .set(pauseKey, new Date().toISOString(), "EX", PAUSE_KEY_TTL_SECONDS)
      .hset(progressKey, {
        status: "pausing",
        details: "Pause requested. The worker will pause at the next safe checkpoint.",
      })
      .expire(progressKey, PAUSE_KEY_TTL_SECONDS)
      .exec();

    assertMultiOk(results, "jobs/pause request");

    const response: PauseJobResponse = {
      job_id: job.id,
      status: "pause_requested",
      message: "Pause requested. The worker will pause at the next safe checkpoint.",
    };
    res.json(response);
  };
}

export function resumeJobHandler(pool: Pool, redis: Redis, config: AppConfig) {
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
      const response: ResumeJobResponse = {
        job_id: job.id,
        status: "already_completed",
        message: "This translation job has already completed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "failed" || job.status === "rolled_back") {
      const response: ResumeJobResponse = {
        job_id: job.id,
        status: "already_failed",
        message:
          job.status === "rolled_back"
            ? "This translation job has already been rolled back."
            : "This translation job has already failed.",
      };
      res.json(response);
      return;
    }

    if (job.status === "canceled") {
      const response: ResumeJobResponse = {
        job_id: job.id,
        status: "already_canceled",
        message: buildCanceledMessage(job),
      };
      res.json(response);
      return;
    }

    const progressKey = `job_progress:${job.id}`;
    const progress = await redis.hgetall(progressKey);
    const liveStatus = readProgressStatus(progress);
    const pauseKey = buildJobPauseKey(job.id);

    if (liveStatus !== "paused" && liveStatus !== "pausing") {
      const response: ResumeJobResponse = {
        job_id: job.id,
        status: "already_running",
        message: "Translation is already running.",
      };
      res.json(response);
      return;
    }

    if (job.status === "pending" || job.status === "queued") {
      await updateJobStatus(pool, job.id, "queued", {
        stageStatus: "queued",
        stageLeaseExpiresAt: null,
        stageLastHeartbeatAt: null,
        queuedTaskName: null,
      });
      const queuedTaskName = await enqueueJob(
        config,
        job.id,
        job.current_stage ?? "extract",
        job.stage_attempt > 0 ? job.stage_attempt : 1,
        { taskKind: "resume" }
      );
      await updateJobStatus(pool, job.id, "queued", {
        queuedTaskName,
      });

      const results = await redis
        .multi()
        .del(pauseKey)
        .del(buildJobCancelKey(job.id))
        .hset(progressKey, {
          status: "queued",
          progress_percent: progress.progress_percent || "0",
          current_step: "queued",
          details: "Job resumed and re-queued for processing.",
        })
        .expire(progressKey, PAUSE_KEY_TTL_SECONDS)
        .exec();

      assertMultiOk(results, "jobs/resume queued progress");

      const response: ResumeJobResponse = {
        job_id: job.id,
        status: "resumed",
        message: "Translation resumed.",
      };
      res.json(response);
      return;
    }

    const synthesizedProgress = buildSynthesizedProgress(job);
    const results = await redis
      .multi()
      .del(pauseKey)
      .del(buildJobCancelKey(job.id))
      .hset(progressKey, {
        status: job.status,
        progress_percent: progress.progress_percent || String(synthesizedProgress.progress_percent),
        current_step:
          progress.current_step && progress.current_step !== "paused" && progress.current_step !== "pausing"
            ? progress.current_step
            : (synthesizedProgress.current_step ?? job.status),
        details: "Resuming translation...",
      })
      .expire(progressKey, PAUSE_KEY_TTL_SECONDS)
      .exec();

    assertMultiOk(results, "jobs/resume running progress");

    const response: ResumeJobResponse = {
      job_id: job.id,
      status: "resumed",
      message: "Translation resumed.",
    };
    res.json(response);
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
        ...buildDriveCleanupSnapshot(job),
      };
      res.json(response);
      return;
    }

    if (job.status === "failed" || job.status === "rolled_back") {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "already_failed",
        message:
          job.status === "rolled_back"
            ? "This translation job has already been rolled back."
            : "This translation job has already failed.",
        ...buildDriveCleanupSnapshot(job),
      };
      res.json(response);
      return;
    }

    if (job.status === "canceled") {
      const response: CancelJobResponse = {
        job_id: job.id,
        status: "already_canceled",
        message: buildCanceledMessage(job),
        ...buildDriveCleanupSnapshot(job),
      };
      res.json(response);
      return;
    }

    const progressKey = `job_progress:${job.id}`;
    const progress = await redis.hgetall(progressKey);
    const liveStatus = readProgressStatus(progress);
    const pauseKey = buildJobPauseKey(job.id);

    if (job.status === "pending" || job.status === "queued") {
      await deleteQueuedJob(config, job.queued_task_name);
      await updateJobStatus(pool, job.id, "canceled", {
        currentStage: null,
        stageStatus: null,
        stageLeaseExpiresAt: null,
        stageLastHeartbeatAt: null,
        queuedTaskName: null,
      });
      const results = await redis
        .multi()
        .del(buildJobCancelKey(job.id))
        .del(pauseKey)
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
        ...buildDriveCleanupSnapshot(job),
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

    const results = await redis
      .multi()
      .set(buildJobCancelKey(job.id), new Date().toISOString(), "EX", CANCEL_KEY_TTL_SECONDS)
      .del(pauseKey)
      .hset(progressKey, {
        status:
          liveStatus === "paused" || liveStatus === "pausing"
            ? job.status
            : (progress.status || job.status),
        details: "Cancellation confirmed. The worker will stop at the next safe checkpoint.",
      })
      .expire(progressKey, CANCEL_KEY_TTL_SECONDS)
      .exec();

    assertMultiOk(results, "jobs/cancel request");

    const response: CancelJobResponse = {
      job_id: job.id,
      status: "cancel_requested",
      message: "Cancellation confirmed. The current step will stop as soon as possible.",
    };
    res.json(response);
  };
}
