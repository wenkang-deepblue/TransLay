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

function requireIntEnv(name: string, raw: string): number {
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig() {
  const nodeEnv = optionalEnv("NODE_ENV", "development");
  const sessionSecret = requireEnv("SESSION_SECRET");

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
    port: requireIntEnv("PORT", optionalEnv("PORT", "8080")),
    nodeEnv,

    gcpProjectId: requireEnv("GCP_PROJECT_ID"),
    gcpRegion: optionalEnv("GCP_REGION", "us-central1"),

    db: {
      host: optionalEnv("DB_HOST", "127.0.0.1"),
      port: requireIntEnv("DB_PORT", optionalEnv("DB_PORT", "5432")),
      name: optionalEnv("DB_NAME", "translay"),
      user: optionalEnv("DB_USER", "translay_app"),
      password: requireEnv("DB_PASSWORD"),
    },

    redis: {
      host: requireEnv("REDIS_HOST"),
      port: requireIntEnv("REDIS_PORT", optionalEnv("REDIS_PORT", "6379")),
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
      cookieName: "translay_sid",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },

    domain: optionalEnv("PRODUCTION_DOMAIN", "your-domain.example.com"),

    entitlementCacheTtl: 300, // seconds, frozen decision
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadWorkerConfig() {
  const nodeEnv = optionalEnv("NODE_ENV", "development");
  const cloudTasksAudience = optionalEnv("CLOUD_TASKS_AUDIENCE", "");
  const cloudTasksInvokerServiceAccount = optionalEnv(
    "CLOUD_TASKS_INVOKER_SA",
    ""
  );

  if (nodeEnv === "production" && !cloudTasksAudience) {
    throw new Error("CLOUD_TASKS_AUDIENCE is required in production");
  }

  if (nodeEnv === "production" && !cloudTasksInvokerServiceAccount) {
    throw new Error("CLOUD_TASKS_INVOKER_SA is required in production");
  }

  return {
    port: requireIntEnv("PORT", optionalEnv("PORT", "8081")),
    nodeEnv,

    gcpProjectId: requireEnv("GCP_PROJECT_ID"),
    gcpRegion: optionalEnv("GCP_REGION", "us-central1"),

    db: {
      host: optionalEnv("DB_HOST", "127.0.0.1"),
      port: requireIntEnv("DB_PORT", optionalEnv("DB_PORT", "5432")),
      name: optionalEnv("DB_NAME", "translay"),
      user: optionalEnv("DB_USER", "translay_app"),
      password: requireEnv("DB_PASSWORD"),
    },

    redis: {
      host: requireEnv("REDIS_HOST"),
      port: requireIntEnv("REDIS_PORT", optionalEnv("REDIS_PORT", "6379")),
    },

    vertex: {
      model: optionalEnv("VERTEX_MODEL", "gemini-3.1-flash-lite-preview"),
      maxInputTokens: 50_000,
      location: optionalEnv("VERTEX_LOCATION", "global"),
    },

    gemmaGpu: {
      url: optionalEnv("GEMMA_GPU_URL", ""),
    },

    cloudTasks: {
      audience: cloudTasksAudience,
      invokerServiceAccount: cloudTasksInvokerServiceAccount,
    },
  } as const;
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
