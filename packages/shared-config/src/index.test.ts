import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadWorkerConfig } from "./index";

const REQUIRED_ENV = {
  SESSION_SECRET: "x".repeat(32),
  GCP_PROJECT_ID: "YOUR_GCP_PROJECT_ID",
  DB_PASSWORD: "postgres",
  REDIS_HOST: "127.0.0.1",
} as const;

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T
): T {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig rejects malformed integer values for bounded fields", () => {
  assert.throws(
    () =>
      withEnv(
        {
          DB_POOL_MAX: "20foo",
          MAX_GLOBAL_INFLIGHT_JOBS: "50",
        },
        () => loadConfig()
      ),
    /DB_POOL_MAX must be a valid integer/
  );
});

test("loadConfig rejects pool sizes above the Track D ceiling", () => {
  assert.throws(
    () =>
      withEnv(
        {
          DB_POOL_MAX: "21",
          MAX_GLOBAL_INFLIGHT_JOBS: "50",
        },
        () => loadConfig()
      ),
    /DB_POOL_MAX must be <= 20/
  );
});

test("loadConfig rejects MAX_GLOBAL_INFLIGHT_JOBS above the Track D ceiling", () => {
  assert.throws(
    () =>
      withEnv(
        {
          MAX_GLOBAL_INFLIGHT_JOBS: "51",
        },
        () => loadConfig()
      ),
    /MAX_GLOBAL_INFLIGHT_JOBS must be <= 50/
  );
});

test("loadConfig provides Track D inbound rate limit defaults", () => {
  const config = withEnv({}, () => loadConfig());
  assert.deepEqual(config.rateLimits, {
    global: { windowSeconds: 60, maxRequests: 1200 },
    userWrite: { windowSeconds: 60, maxRequests: 30 },
    userRead: { windowSeconds: 60, maxRequests: 120 },
  });
});

test("loadConfig honors RATE_LIMIT_* overrides and validates bounds", () => {
  const config = withEnv(
    {
      RATE_LIMIT_GLOBAL_MAX_REQUESTS: "300",
      RATE_LIMIT_USER_WRITE_MAX_REQUESTS: "10",
      RATE_LIMIT_USER_READ_MAX_REQUESTS: "240",
      RATE_LIMIT_USER_READ_WINDOW_SECONDS: "30",
    },
    () => loadConfig()
  );
  assert.equal(config.rateLimits.global.maxRequests, 300);
  assert.equal(config.rateLimits.userWrite.maxRequests, 10);
  assert.equal(config.rateLimits.userRead.maxRequests, 240);
  assert.equal(config.rateLimits.userRead.windowSeconds, 30);

  assert.throws(
    () =>
      withEnv(
        { RATE_LIMIT_GLOBAL_MAX_REQUESTS: "0" },
        () => loadConfig()
      ),
    /RATE_LIMIT_GLOBAL_MAX_REQUESTS must be >= 1/
  );
});

test("loadWorkerConfig prefers WORKER_DB_POOL_MAX and enforces bounds", () => {
  const config = withEnv(
    {
      WORKER_DB_POOL_MAX: "7",
      DB_POOL_MAX: "20",
    },
    () => loadWorkerConfig()
  );

  assert.equal(config.db.poolMax, 7);
  const overrideWins = withEnv(
    {
      WORKER_DB_POOL_MAX: "8",
      DB_POOL_MAX: "99",
    },
    () => loadWorkerConfig()
  );
  assert.equal(overrideWins.db.poolMax, 8);
  assert.throws(
    () =>
      withEnv(
        {
          WORKER_DB_POOL_MAX: "0",
        },
        () => loadWorkerConfig()
      ),
    /WORKER_DB_POOL_MAX must be >= 1/
  );
});

test("loadWorkerConfig rejects unsigned task bypass outside development", () => {
  assert.throws(
    () =>
      withEnv(
        {
          NODE_ENV: "test",
          ALLOW_UNSIGNED_TASKS: "true",
        },
        () => loadWorkerConfig()
      ),
    /ALLOW_UNSIGNED_TASKS is only allowed in development/
  );
});
