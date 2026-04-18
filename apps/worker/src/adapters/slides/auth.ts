import type { Pool } from "pg";
import { kmsDecrypt } from "@translay/shared-config/dist/kms";
import { google } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type PersistedHostOauthSource = "addon" | "sa_fallback";

type ServiceAccountSlidesClient = {
  auth: InstanceType<typeof google.auth.GoogleAuth>;
  slides: ReturnType<typeof google.slides>;
};

type UserSlidesClient = {
  auth: OAuth2Client;
  slides: ReturnType<typeof google.slides>;
};

type SlidesClientCore = ServiceAccountSlidesClient | UserSlidesClient;
type SlidesAuthClient = SlidesClientCore["auth"];
type SlidesClientSource = "user" | "sa_fallback";

type SlidesAuthRow = {
  user_id: string;
  host_oauth_access_token_enc: Buffer | string | null;
  host_oauth_token_expires_at: Date | string | null;
  host_oauth_source: PersistedHostOauthSource;
};

type SlidesAuthTestHooks = {
  decryptToken?: typeof kmsDecrypt;
  nowMs?: () => number;
  buildUserSlidesClient?: (accessToken: string) => UserSlidesClient;
};

export interface SlidesClientContext {
  auth: SlidesAuthClient;
  slides: ReturnType<typeof google.slides>;
  source: SlidesClientSource;
  scopeOk: boolean;
  readonly jobId?: string;
  readonly userId?: string;
  fallbackToServiceAccount: (reason?: string, error?: unknown) => Promise<void>;
  markScopeValidated: () => void;
}

const USER_TOKEN_MIN_TTL_MS = 2 * 60 * 1000;

let serviceAccountClients: ServiceAccountSlidesClient | null = null;
let decryptToken = kmsDecrypt;
let nowMs = () => Date.now();
let buildUserSlidesClient = (accessToken: string): UserSlidesClient => {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return {
    auth,
    slides: google.slides({ version: "v1", auth }),
  };
};

/** Get authenticated Slides API client using default credentials. */
export function getSlidesClient(): ServiceAccountSlidesClient {
  if (serviceAccountClients) {
    return serviceAccountClients;
  }

  const auth = new google.auth.GoogleAuth({
    // Service-account writeback needs the Slides REST edit scope; currentonly is
    // limited to active-container user flows and does not cover worker fallback.
    scopes: ["https://www.googleapis.com/auth/presentations"],
  });

  serviceAccountClients = {
    auth,
    slides: google.slides({ version: "v1", auth }),
  };

  return serviceAccountClients;
}

export function getSlidesAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  return getSlidesClient().auth;
}

export async function getSlidesClientForJob(
  jobId: string,
  pool: Pool
): Promise<SlidesClientContext> {
  const result = await pool.query(
    `SELECT user_id, host_oauth_access_token_enc, host_oauth_token_expires_at, host_oauth_source
       FROM translation_jobs
      WHERE id = $1`,
    [jobId]
  );
  const row = result.rows[0] as SlidesAuthRow | undefined;
  if (!row) {
    throw new Error(`Translation job ${jobId} not found while resolving Slides auth`);
  }

  const context = createSlidesClientContext(
    pool,
    jobId,
    row.user_id,
    getSlidesClient(),
    "sa_fallback"
  );
  if (shouldUseUserOauth(row)) {
    const encryptedToken = coerceEncryptedToken(row.host_oauth_access_token_enc);
    if (encryptedToken) {
      try {
        const accessToken = await decryptToken(encryptedToken);
        const userClient = buildUserSlidesClient(accessToken);
        context.auth = userClient.auth;
        context.slides = userClient.slides;
        context.source = "user";
      } catch (error) {
        await persistHostOauthSource(pool, jobId, "sa_fallback");
        console.warn(
          "[slides-auth] failed to restore host OAuth token, using service account fallback",
          JSON.stringify({
            job_id: jobId,
            user_id: row.user_id,
            error_message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
  } else if (row.host_oauth_source !== "sa_fallback") {
    await persistHostOauthSource(pool, jobId, "sa_fallback");
  }

  console.info(
    "[slides-auth] selected client",
    JSON.stringify({
      job_id: jobId,
      user_id: row.user_id,
      source: context.source,
      scope_ok: context.scopeOk,
    })
  );
  return context;
}

export async function getSlidesAccessToken(
  auth: SlidesAuthClient
): Promise<string | null> {
  if ("getClient" in auth && typeof auth.getClient === "function") {
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    return typeof accessToken === "string" ? accessToken : accessToken?.token ?? null;
  }

  const accessToken = await auth.getAccessToken();
  return typeof accessToken === "string" ? accessToken : accessToken?.token ?? null;
}

export function isUserTokenAuthError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: {
      status?: unknown;
      data?: unknown;
    };
    message?: unknown;
    errors?: Array<{ reason?: unknown }>;
  };
  const status = [candidate.status, candidate.response?.status, candidate.code].find(
    (value) => typeof value === "number"
  );
  const nestedReasons = extractNestedReasons(candidate.response?.data);
  const reasonTokens = [
    ...(candidate.errors ?? []).map((entry) =>
      typeof entry.reason === "string" ? entry.reason : ""
    ),
    ...nestedReasons.map((entry) =>
      typeof entry.reason === "string" ? entry.reason : ""
    ),
  ].filter(Boolean);
  const hasQuotaReason = reasonTokens.some((reason) =>
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)
  );
  const hasAuthReason = reasonTokens.some((reason) =>
    /authError|insufficientPermissions|accessNotConfigured|forbidden/i.test(reason)
  );
  if (status === 401) {
    return true;
  }
  if (hasQuotaReason) {
    return false;
  }
  if (status === 403 && !hasQuotaReason) {
    return hasAuthReason || reasonTokens.length === 0;
  }

  const message = [
    typeof candidate.message === "string" ? candidate.message : "",
    typeof candidate.response?.data === "string" ? candidate.response.data : "",
    ...reasonTokens,
  ]
    .filter(Boolean)
    .join(" ");

  return /invalid[_ ]grant|autherror|invalid credentials|insufficient authentication scopes|request had insufficient authentication scopes|insufficientpermissions|accessnotconfigured|forbidden/i.test(
    message
  );
}

function createSlidesClientContext(
  pool: Pool,
  jobId: string,
  userId: string,
  initialClient: SlidesClientCore,
  initialSource: SlidesClientSource
): SlidesClientContext {
  const context: SlidesClientContext = {
    auth: initialClient.auth,
    slides: initialClient.slides,
    source: initialSource,
    scopeOk: false,
    jobId,
    userId,
    fallbackToServiceAccount: async () => undefined,
    markScopeValidated: () => undefined,
  };

  context.markScopeValidated = () => {
    if (context.source === "user") {
      context.scopeOk = true;
    }
  };

  context.fallbackToServiceAccount = async (reason = "slides_auth_error", error) => {
    if (context.source === "sa_fallback") {
      return;
    }

    const fallbackClient = getSlidesClient();
    context.auth = fallbackClient.auth;
    context.slides = fallbackClient.slides;
    context.source = "sa_fallback";
    context.scopeOk = false;
    await persistHostOauthSource(pool, jobId, "sa_fallback");
    console.warn(
      "[slides-auth] falling back to service account",
      JSON.stringify({
        job_id: jobId,
        user_id: userId,
        reason,
        error_message: error instanceof Error ? error.message : String(error),
      })
    );
  };

  return context;
}

function shouldUseUserOauth(row: SlidesAuthRow): boolean {
  if (row.host_oauth_source === "sa_fallback") {
    return false;
  }

  if (!row.host_oauth_access_token_enc) {
    return false;
  }

  const expiresAtMs = coerceExpiresAtMs(row.host_oauth_token_expires_at);
  if (expiresAtMs === null) {
    return false;
  }

  return expiresAtMs >= nowMs() + USER_TOKEN_MIN_TTL_MS;
}

function coerceExpiresAtMs(value: SlidesAuthRow["host_oauth_token_expires_at"]): number | null {
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
  value: SlidesAuthRow["host_oauth_access_token_enc"]
): Buffer | null {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(normalized, "hex");
}

async function persistHostOauthSource(
  pool: Pool | undefined,
  jobId: string,
  source: SlidesClientSource
): Promise<void> {
  if (!pool) {
    return;
  }
  await pool.query(
    `UPDATE translation_jobs
        SET host_oauth_source = $2
      WHERE id = $1
        AND host_oauth_source IS DISTINCT FROM $2`,
    [jobId, source]
  );
}

export function __setSlidesClientForTests(
  nextClients: ServiceAccountSlidesClient
): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Test Slides client injection is disabled in production-like environments");
  }
  serviceAccountClients = nextClients;
}

export function __setSlidesAuthHooksForTests(hooks: SlidesAuthTestHooks): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Slides auth test hooks are disabled in production-like environments");
  }
  if (hooks.decryptToken) {
    decryptToken = hooks.decryptToken;
  }
  if (hooks.nowMs) {
    nowMs = hooks.nowMs;
  }
  if (hooks.buildUserSlidesClient) {
    buildUserSlidesClient = hooks.buildUserSlidesClient;
  }
}

export function __resetSlidesClientForTests(): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Test Slides client reset is disabled in production-like environments");
  }
  serviceAccountClients = null;
  decryptToken = kmsDecrypt;
  nowMs = () => Date.now();
  buildUserSlidesClient = (accessToken: string): UserSlidesClient => {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return {
      auth,
      slides: google.slides({ version: "v1", auth }),
    };
  };
}

function extractNestedReasons(data: unknown): Array<{ reason?: unknown }> {
  if (
    typeof data !== "object" ||
    data === null ||
    !("error" in data) ||
    typeof (data as { error?: unknown }).error !== "object" ||
    (data as { error?: unknown }).error === null ||
    !("errors" in ((data as { error: { errors?: unknown } }).error ?? {}))
  ) {
    return [];
  }

  return (
    (data as {
      error: { errors?: Array<{ reason?: unknown }> };
    }).error.errors ?? []
  );
}

function isProductionLikeNodeEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
}
