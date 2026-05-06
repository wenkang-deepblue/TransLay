import type { Pool } from "pg";
import { kmsDecrypt } from "@translay/shared-config/dist/kms";
import { google } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type DriveClient = ReturnType<typeof google.drive>;
type PersistedHostOauthSource = "addon" | "sa_fallback";

type DriveAuthRow = {
  user_id: string;
  host_oauth_access_token_enc: Buffer | string | null;
  host_oauth_token_expires_at: Date | string | null;
  host_oauth_source: PersistedHostOauthSource;
};

type UserDriveClient = {
  auth: OAuth2Client;
  drive: DriveClient;
};

type DriveAuthTestHooks = {
  decryptToken?: typeof kmsDecrypt;
  nowMs?: () => number;
  buildUserDriveClient?: (accessToken: string) => UserDriveClient;
};

export type DriveCleanupAuthErrorCode =
  | "job_not_found"
  | "host_oauth_token_missing"
  | "host_oauth_token_expired"
  | "host_oauth_decrypt_failed"
  | "host_oauth_client_build_failed";

export interface DriveClientContext {
  readonly auth: OAuth2Client;
  readonly drive: DriveClient;
  readonly source: "user";
  readonly jobId: string;
  readonly userId: string;
}

export class DriveCleanupAuthError extends Error {
  constructor(
    readonly code: DriveCleanupAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DriveCleanupAuthError";
  }
}

const HOST_OAUTH_CLEANUP_MIN_TTL_MS = 2 * 60 * 1000;
const DEFAULT_NOW_MS = () => Date.now();
const DEFAULT_BUILD_USER_DRIVE_CLIENT = (accessToken: string): UserDriveClient => {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return {
    auth,
    drive: google.drive({ version: "v3", auth }),
  };
};

let decryptToken = kmsDecrypt;
let nowMs = DEFAULT_NOW_MS;
let buildUserDriveClient = DEFAULT_BUILD_USER_DRIVE_CLIENT;

export async function getDriveClientForJob(
  jobId: string,
  pool: Pool
): Promise<DriveClientContext> {
  const result = await pool.query(
    `SELECT user_id, host_oauth_access_token_enc, host_oauth_token_expires_at, host_oauth_source
       FROM translation_jobs
      WHERE id = $1`,
    [jobId]
  );
  const row = result.rows[0] as DriveAuthRow | undefined;
  if (!row) {
    throw new DriveCleanupAuthError(
      "job_not_found",
      "Translation job was not found while resolving Drive cleanup auth"
    );
  }

  const encryptedToken = coerceEncryptedToken(row.host_oauth_access_token_enc);
  if (!encryptedToken) {
    throw new DriveCleanupAuthError(
      "host_oauth_token_missing",
      "Host OAuth token is missing for Drive cleanup"
    );
  }

  const expiresAtMs = coerceExpiresAtMs(row.host_oauth_token_expires_at);
  if (expiresAtMs === null || expiresAtMs < nowMs() + HOST_OAUTH_CLEANUP_MIN_TTL_MS) {
    throw new DriveCleanupAuthError(
      "host_oauth_token_expired",
      "Host OAuth token is expired for Drive cleanup"
    );
  }

  let accessToken: string;
  try {
    accessToken = await decryptToken(encryptedToken);
  } catch {
    throw new DriveCleanupAuthError(
      "host_oauth_decrypt_failed",
      "Host OAuth token could not be decrypted for Drive cleanup"
    );
  }

  let client: UserDriveClient;
  try {
    client = buildUserDriveClient(accessToken);
  } catch {
    throw new DriveCleanupAuthError(
      "host_oauth_client_build_failed",
      "Host OAuth Drive client could not be built for cleanup"
    );
  }
  return {
    ...client,
    source: "user",
    jobId,
    userId: row.user_id,
  };
}

export function __setDriveAuthHooksForTests(hooks: DriveAuthTestHooks): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive auth test hooks are disabled in production-like environments");
  }
  if (hooks.decryptToken) {
    decryptToken = hooks.decryptToken;
  }
  if (hooks.nowMs) {
    nowMs = hooks.nowMs;
  }
  if (hooks.buildUserDriveClient) {
    buildUserDriveClient = hooks.buildUserDriveClient;
  }
}

export function __resetDriveAuthHooksForTests(): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Drive auth test hooks are disabled in production-like environments");
  }
  decryptToken = kmsDecrypt;
  nowMs = DEFAULT_NOW_MS;
  buildUserDriveClient = DEFAULT_BUILD_USER_DRIVE_CLIENT;
}

function coerceExpiresAtMs(value: DriveAuthRow["host_oauth_token_expires_at"]): number | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceEncryptedToken(
  value: DriveAuthRow["host_oauth_access_token_enc"]
): Buffer | null {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength > 0 ? value : null;
  }
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return null;
  }
  const buffer = Buffer.from(normalized, "hex");
  return buffer.byteLength > 0 ? buffer : null;
}

function isProductionLikeNodeEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
}
