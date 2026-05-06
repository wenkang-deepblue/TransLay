import type { Pool } from "pg";
import type { DriveCleanupStatus } from "@translay/shared-contracts";
import {
  DriveCleanupAuthError,
  getDriveClientForJob,
  type DriveClientContext,
} from "./auth";

type DrivePermissionsClient = DriveClientContext["drive"];

export interface DriveCleanupJob {
  readonly id: string;
  readonly source_doc_id: string;
  readonly target_doc_id: string | null;
  readonly source_worker_permission_id: string | null;
  readonly target_worker_permission_id: string | null;
}

export interface DriveCleanupTarget {
  readonly kind: "source" | "target";
  readonly fileId: string;
  readonly permissionId: string;
}

export interface DriveCleanupResult {
  // Worker cleanup only emits terminal cleanup states; "pending" is persisted by job creation.
  readonly status: Extract<DriveCleanupStatus, "not_required" | "succeeded" | "failed">;
  readonly attempted: boolean;
  readonly errorCode: string | null;
  readonly targetCount: number;
}

type DrivePermissionsTestHooks = {
  getDriveClientForJob?: typeof getDriveClientForJob;
  sleep?: (ms: number) => Promise<void>;
};

const DRIVE_PERMISSION_DELETE_TIMEOUT_MS = 10_000;
// Cleanup runs during terminal finalize; retries stay bounded to avoid long token-purge delays.
const DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS = [500, 1_000] as const;
const DEFAULT_SLEEP = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let resolveDriveClientForJob = getDriveClientForJob;
let sleep = DEFAULT_SLEEP;

export async function cleanupDriveWorkerPermissionsForJob(
  pool: Pool,
  job: DriveCleanupJob
): Promise<DriveCleanupResult> {
  const targets = buildDriveCleanupTargets(job);
  if (targets.length === 0) {
    return {
      status: "not_required",
      attempted: false,
      errorCode: null,
      targetCount: 0,
    };
  }

  let client: DriveClientContext;
  try {
    client = await resolveDriveClientForJob(job.id, pool);
  } catch (error) {
    return {
      status: "failed",
      attempted: true,
      errorCode: normalizeDriveCleanupErrorCode(error),
      targetCount: targets.length,
    };
  }

  let firstErrorCode: string | null = null;
  for (const target of targets) {
    try {
      await revokeDrivePermission(client.drive, target);
    } catch (error) {
      firstErrorCode ??= normalizeDriveCleanupErrorCode(error);
    }
  }

  return {
    status: firstErrorCode ? "failed" : "succeeded",
    attempted: true,
    errorCode: firstErrorCode,
    targetCount: targets.length,
  };
}

export function buildDriveCleanupTargets(job: DriveCleanupJob): DriveCleanupTarget[] {
  const targets: DriveCleanupTarget[] = [];
  if (job.source_worker_permission_id) {
    targets.push({
      kind: "source",
      fileId: job.source_doc_id,
      permissionId: job.source_worker_permission_id,
    });
  }

  if (
    job.target_doc_id &&
    job.target_doc_id !== job.source_doc_id &&
    job.target_worker_permission_id
  ) {
    targets.push({
      kind: "target",
      fileId: job.target_doc_id,
      permissionId: job.target_worker_permission_id,
    });
  }

  return targets;
}

export async function revokeDrivePermission(
  drive: DrivePermissionsClient,
  target: DriveCleanupTarget
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await deleteDrivePermissionOnce(drive, target);
      return;
    } catch (error) {
      if (isPermissionAlreadyRemoved(error)) {
        return;
      }
      lastError = error;
      const retryDelayMs = DRIVE_PERMISSION_DELETE_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableDriveCleanupError(error)) {
        break;
      }
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

export function __setDrivePermissionsHooksForTests(hooks: DrivePermissionsTestHooks): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive permissions test hooks are disabled in production-like environments");
  }
  if (hooks.getDriveClientForJob) {
    resolveDriveClientForJob = hooks.getDriveClientForJob;
  }
  if (hooks.sleep) {
    sleep = hooks.sleep;
  }
}

export function __resetDrivePermissionsHooksForTests(): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive permissions test hooks are disabled in production-like environments");
  }
  resolveDriveClientForJob = getDriveClientForJob;
  sleep = DEFAULT_SLEEP;
}

function isPermissionAlreadyRemoved(error: unknown): boolean {
  return extractErrorStatus(error) === 404;
}

async function deleteDrivePermissionOnce(
  drive: DrivePermissionsClient,
  target: DriveCleanupTarget
): Promise<void> {
  await drive.permissions.delete(
    {
      fileId: target.fileId,
      permissionId: target.permissionId,
      supportsAllDrives: true,
    },
    { timeout: DRIVE_PERMISSION_DELETE_TIMEOUT_MS }
  );
}

function normalizeDriveCleanupErrorCode(error: unknown): string {
  if (error instanceof DriveCleanupAuthError) {
    return error.code;
  }

  const status = extractErrorStatus(error);
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
  const transportCode = extractTransportCode(error);
  if (transportCode && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE/i.test(transportCode)) {
    return "drive_cleanup_network_error";
  }
  return "drive_permission_delete_failed";
}

function isRetryableDriveCleanupError(error: unknown): boolean {
  const status = extractErrorStatus(error);
  if (status !== null) {
    return status === 429 || status >= 500;
  }
  const transportCode = extractTransportCode(error);
  return Boolean(
    transportCode &&
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE/i.test(transportCode)
  );
}

function extractErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
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
    candidate.code,
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

function extractTransportCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isProductionLikeNodeEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
}
