/** Requires an environment variable to be set. Throws at startup if missing. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean, got: ${raw}`);
}

function optionalIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return requireIntEnv(name, raw);
}

function optionalBoundedIntEnv(
  name: string,
  fallback: number,
  options: {
    readonly min?: number;
    readonly max?: number;
  } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return requireBoundedIntEnv(name, raw, options);
}

function requireIntEnv(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: ${raw}`);
  }
  return parsed;
}

function requireBoundedIntEnv(
  name: string,
  raw: string,
  options: {
    readonly min?: number;
    readonly max?: number;
  } = {}
): number {
  const parsed = requireIntEnv(name, raw);
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Environment variable ${name} must be >= ${options.min}, got: ${raw}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Environment variable ${name} must be <= ${options.max}, got: ${raw}`);
  }
  return parsed;
}

function resolveServicePoolMax(serviceSpecificEnvName: string): number {
  const serviceSpecificValue = process.env[serviceSpecificEnvName];
  if (serviceSpecificValue !== undefined) {
    return requireBoundedIntEnv(serviceSpecificEnvName, serviceSpecificValue, {
      min: 1,
      max: 20,
    });
  }
  return optionalBoundedIntEnv("DB_POOL_MAX", 20, { min: 1, max: 20 });
}

export function loadConfig() {
  const nodeEnv = optionalEnv("NODE_ENV", "development");
  const sessionSecret = requireEnv("SESSION_SECRET");
  const kmsKeyName = process.env.KMS_KEY_NAME ?? null;
  const internalCronSecret = process.env.INTERNAL_CRON_SECRET ?? null;

  // S10: SESSION_SECRET must be at least 32 characters
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  const workerUrl = optionalEnv("WORKER_URL", "");
  const normalizedWorkerUrl = workerUrl.replace(/\/$/, "");
  const cloudTasksAudience = optionalEnv(
    "CLOUD_TASKS_AUDIENCE",
    normalizedWorkerUrl ? `${normalizedWorkerUrl}/tasks/translate` : ""
  );

  // S10: WORKER_URL must be set in production
  if (nodeEnv === "production" && !workerUrl) {
    throw new Error("WORKER_URL is required in production");
  }

  return {
    port: optionalIntEnv("PORT", 8080),
    nodeEnv,

    gcpProjectId: requireEnv("GCP_PROJECT_ID"),
    gcpRegion: optionalEnv("GCP_REGION", "us-central1"),

    db: {
      host: optionalEnv("DB_HOST", "127.0.0.1"),
      port: optionalIntEnv("DB_PORT", 5432),
      name: optionalEnv("DB_NAME", "translay"),
      user: optionalEnv("DB_USER", "translay_app"),
      password: requireEnv("DB_PASSWORD"),
      poolMax: resolveServicePoolMax("CONTROL_PLANE_DB_POOL_MAX"),
    },

    redis: {
      host: requireEnv("REDIS_HOST"),
      port: optionalIntEnv("REDIS_PORT", 6379),
    },

    cloudTasks: {
      queueName: optionalEnv("CLOUD_TASKS_QUEUE_NAME", "YOUR_CLOUD_TASKS_QUEUE"),
      location: optionalEnv("CLOUD_TASKS_LOCATION", "us-central1"),
      workerUrl,
      audience: cloudTasksAudience,
      invokerServiceAccount: optionalEnv(
        "CLOUD_TASKS_INVOKER_SA",
        ""
      ),
    },

    session: {
      secret: sessionSecret,
      cookieName: "__Host-translay_sid",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },

    domain: optionalEnv("PRODUCTION_DOMAIN", "your-domain.example.com"),

    entitlementCacheTtl: 300, // seconds, frozen decision

    jobs: {
      maxGlobalInFlightJobs: optionalBoundedIntEnv("MAX_GLOBAL_INFLIGHT_JOBS", 50, { min: 1, max: 50 }),
    },

    security: {
      kmsKeyName,
      internalCronSecret,
    },
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadWorkerConfig() {
  const nodeEnv = optionalEnv("NODE_ENV", "development");
  const workerUrl = optionalEnv("WORKER_URL", "").replace(/\/$/, "");
  const cloudTasksAudience = optionalEnv("CLOUD_TASKS_AUDIENCE", "");
  const cloudTasksInvokerServiceAccount = optionalEnv(
    "CLOUD_TASKS_INVOKER_SA",
    ""
  );
  const allowUnsignedTasks = optionalBooleanEnv("ALLOW_UNSIGNED_TASKS", false);
  const kmsKeyName = process.env.KMS_KEY_NAME ?? null;
  const captureLlmOutputs = optionalBooleanEnv("DEBUG_CAPTURE_LLM_OUTPUTS", false);
  const allowDevTestRawOutputPersistence = optionalBooleanEnv(
    "DEBUG_ALLOW_DEV_TEST_RAW_OUTPUT_PERSISTENCE",
    false
  );
  const productionLikeNodeEnv = nodeEnv === "production" || nodeEnv === "staging";

  if (nodeEnv === "production" && !cloudTasksAudience) {
    throw new Error("CLOUD_TASKS_AUDIENCE is required in production");
  }

  if (nodeEnv === "production" && !cloudTasksInvokerServiceAccount) {
    throw new Error("CLOUD_TASKS_INVOKER_SA is required in production");
  }

  if (nodeEnv === "production" && !workerUrl) {
    throw new Error("WORKER_URL is required in production");
  }

  if (productionLikeNodeEnv && captureLlmOutputs) {
    console.warn(
      "DEBUG_CAPTURE_LLM_OUTPUTS is ignored in production-like environments."
    );
  }

  if (allowUnsignedTasks && nodeEnv !== "development") {
    throw new Error("ALLOW_UNSIGNED_TASKS is only allowed in development");
  }

  const effectiveCaptureLlmOutputs = productionLikeNodeEnv ? false : captureLlmOutputs;

  return {
    port: optionalIntEnv("PORT", 8081),
    nodeEnv,

    gcpProjectId: requireEnv("GCP_PROJECT_ID"),
    gcpRegion: optionalEnv("GCP_REGION", "us-central1"),

    db: {
      host: optionalEnv("DB_HOST", "127.0.0.1"),
      port: optionalIntEnv("DB_PORT", 5432),
      name: optionalEnv("DB_NAME", "translay"),
      user: optionalEnv("DB_USER", "translay_app"),
      password: requireEnv("DB_PASSWORD"),
      poolMax: resolveServicePoolMax("WORKER_DB_POOL_MAX"),
    },

    redis: {
      host: requireEnv("REDIS_HOST"),
      port: optionalIntEnv("REDIS_PORT", 6379),
    },

    vertex: {
      model: optionalEnv("VERTEX_MODEL", "gemini-3.1-flash-lite-preview"),
      location: optionalEnv("VERTEX_LOCATION", "global"),
    },

    gemmaGpu: {
      url: optionalEnv("GEMMA_GPU_URL", ""),
    },

    cloudTasks: {
      queueName: optionalEnv("CLOUD_TASKS_QUEUE_NAME", "YOUR_CLOUD_TASKS_QUEUE"),
      location: optionalEnv("CLOUD_TASKS_LOCATION", "us-central1"),
      workerUrl,
      audience: cloudTasksAudience,
      invokerServiceAccount: cloudTasksInvokerServiceAccount,
      allowUnsignedTasks,
    },

    // Development-only debugging toggle. raw model output capture is a temporary
    // development/testing escape hatch and must be removed or disabled before
    // production hardening is finalized.
    debug: {
      captureLlmOutputs: effectiveCaptureLlmOutputs,
      allowDevTestRawOutputPersistence,
      llmOutputRetentionHours: requireIntEnv(
        "DEBUG_LLM_OUTPUT_RETENTION_HOURS",
        optionalEnv("DEBUG_LLM_OUTPUT_RETENTION_HOURS", "72")
      ),
    },

    security: {
      kmsKeyName,
    },
  } as const;
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export { kmsEncrypt, kmsDecrypt, __setKmsClientForTests } from "./kms";
