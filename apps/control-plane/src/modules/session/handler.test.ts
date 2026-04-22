import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type { GoogleIdentity, UserId } from "@translay/shared-contracts";
import {
  sessionConsumeHandler,
  sessionLoginHandler,
  sessionMeHandler,
} from "./handler";

interface MockResponseState {
  statusCode: number;
  body: unknown;
  headers: Record<string, string | string[]>;
}

function makeResponse(): { res: Response; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 200,
    body: null,
    headers: {},
  };

  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      state.headers[name] = value;
      return this;
    },
    getHeader(name: string) {
      return state.headers[name];
    },
  } as unknown as Response;

  return { res, state };
}

function makeConfig(): AppConfig {
  return {
    port: 8080,
    nodeEnv: "test",
    gcpProjectId: "YOUR_GCP_PROJECT_ID",
    gcpRegion: "us-central1",
    db: {
      host: "localhost",
      port: 5432,
      name: "translay",
      user: "postgres",
      password: "postgres",
      poolMax: 5,
    },
    redis: { host: "localhost", port: 6379 },
    cloudTasks: {
      queueName: "YOUR_CLOUD_TASKS_QUEUE",
      location: "us-central1",
      workerUrl: "https://worker.example.com",
      audience: "https://worker.example.com/tasks/translate",
      invokerServiceAccount: "",
    },
    session: {
      secret: "not-a-real-test-session-secret",
      cookieName: "__Host-translay_sid",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    domain: "your-domain.example.com",
    publicAuth: {
      googleWebClientId: "",
      googleIdTokenAudiences: [],
    },
    entitlementCacheTtl: 300,
    jobs: { maxGlobalInFlightJobs: 50 },
    rateLimits: {
      global: { windowSeconds: 60, maxRequests: 1200 },
      userWrite: { windowSeconds: 60, maxRequests: 30 },
      userRead: { windowSeconds: 60, maxRequests: 1200 },
    },
    security: {
      hostOauthTokenRetentionDays: 7,
      hostOauthTokenSweepBatchSize: 500,
      internalCronSecret: null,
    },
  } as unknown as AppConfig;
}

function makePool(): Pool {
  const pool = {
    async query(sql: string, params: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [
            {
              id: params[0],
              google_subject_id: "google-sub-123",
              email: "user@example.com",
              display_name: "Portal User",
            },
          ],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [
            {
              id: "sub_123",
              user_id: params[0],
              plan_type: "free",
              status: "active",
              provider_name: "none",
              provider_customer_id: null,
              provider_subscription_id: null,
              current_period_start: null,
              current_period_end: null,
              cancel_at_period_end: false,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL in test pool: ${sql}`);
    },
  } as unknown as Pool;

  return pool;
}

function makeRedisForSessionWrites(): {
  redis: Redis;
  writes: Array<Record<string, string>>;
  deletedKeys: string[];
} {
  const writes: Array<Record<string, string>> = [];
  const deletedKeys: string[] = [];

  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
    multi() {
      const commands: Array<[Error | null, unknown]> = [];
      return {
        hset(_key: string, fields: Record<string, string>) {
          writes.push(fields);
          commands.push([null, 1]);
          return this;
        },
        expire(_key: string, _ttl: number) {
          commands.push([null, 1]);
          return this;
        },
        async exec() {
          return commands;
        },
      };
    },
  } as unknown as Redis;

  return { redis, writes, deletedKeys };
}

test("sessionLoginHandler creates a portal session and returns avatar without exposing token-shaped fields", async () => {
  const pool = makePool();
  const { redis, writes } = makeRedisForSessionWrites();
  const handler = sessionLoginHandler(pool, redis, makeConfig(), async () => ({
    google_subject_id: "google-sub-123" as GoogleIdentity["google_subject_id"],
    email: "user@example.com",
    display_name: "Portal User",
    avatar_url: "https://lh3.googleusercontent.com/a/example-avatar",
  }), async () => "user-123" as UserId);

  const req = {
    headers: {
      authorization: "Bearer id-token-from-gis",
    },
  } as unknown as Request;
  const { res, state } = makeResponse();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.user_id, "user-123");
  assert.match(writes[0]?.expires_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    writes[0]?.avatar_url,
    "https://lh3.googleusercontent.com/a/example-avatar"
  );
  assert.match(String(state.headers["Set-Cookie"] ?? ""), /__Host-translay_sid=/);

  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://lh3.googleusercontent.com/a/example-avatar",
    },
    plan_type: "free",
    subscription_status: "active",
  });
});

test("sessionLoginHandler replaces an existing portal session cookie after issuing a new one", async () => {
  const pool = makePool();
  const { redis, deletedKeys } = makeRedisForSessionWrites();
  const handler = sessionLoginHandler(pool, redis, makeConfig(), async () => ({
    google_subject_id: "google-sub-123" as GoogleIdentity["google_subject_id"],
    email: "user@example.com",
    display_name: "Portal User",
    avatar_url: null,
  }), async () => "user-123" as UserId);

  const req = {
    headers: {
      authorization: "Bearer id-token-from-gis",
      cookie: "__Host-translay_sid=old-session-id",
    },
  } as unknown as Request;
  const { res } = makeResponse();

  await handler(req, res);

  assert.deepEqual(deletedKeys, ["portal_session:old-session-id"]);
});

test("sessionConsumeHandler carries avatar_url from ticket payload into the portal session response", async () => {
  const pool = makePool();
  const { redis, writes } = makeRedisForSessionWrites();
  const redisWithEval = {
    ...redis,
    async eval() {
      return JSON.stringify({
        user_id: "user-123",
        avatar_url: "https://lh3.googleusercontent.com/a/ticket-avatar",
      });
    },
  } as unknown as Redis;

  const handler = sessionConsumeHandler(pool, redisWithEval, makeConfig());
  const req = {
    body: {
      ticket: "ttk_123",
    },
  } as unknown as Request;
  const { res, state } = makeResponse();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.user_id, "user-123");
  assert.match(writes[0]?.expires_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    writes[0]?.avatar_url,
    "https://lh3.googleusercontent.com/a/ticket-avatar"
  );
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://lh3.googleusercontent.com/a/ticket-avatar",
    },
    plan_type: "free",
    subscription_status: "active",
  });
});

test("sessionLoginHandler returns 503 when subscription lookup fails", async () => {
  const failingPool = {
    async query(sql: string) {
      if (sql.includes("FROM subscriptions")) {
        throw new Error("db unavailable");
      }

      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [
            {
              id: "user-123",
              google_subject_id: "google-sub-123",
              email: "user@example.com",
              display_name: "Portal User",
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL in test pool: ${sql}`);
    },
  } as unknown as Pool;
  const { redis } = makeRedisForSessionWrites();
  const handler = sessionLoginHandler(failingPool, redis, makeConfig(), async () => ({
    google_subject_id: "google-sub-123" as GoogleIdentity["google_subject_id"],
    email: "user@example.com",
    display_name: "Portal User",
    avatar_url: null,
  }), async () => "user-123" as UserId);

  const req = {
    headers: {
      authorization: "Bearer id-token-from-gis",
    },
  } as unknown as Request;
  const { res, state } = makeResponse();

  await handler(req, res);

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.body, {
    error: "SERVICE_UNAVAILABLE",
    message: "Service temporarily unavailable",
  });
});

test("sessionLoginHandler passes configured Google ID token audiences to the resolver", async () => {
  const pool = makePool();
  const { redis } = makeRedisForSessionWrites();
  const config = {
    ...makeConfig(),
    nodeEnv: "production",
    publicAuth: {
      googleWebClientId: "landing-client.apps.googleusercontent.com",
      googleIdTokenAudiences: [
        "landing-client.apps.googleusercontent.com",
        "addon-client.apps.googleusercontent.com",
      ],
    },
  } as AppConfig;
  let receivedOptions:
    | {
        readonly allowedIdTokenAudiences: readonly string[];
        readonly allowUnscopedIdTokens: boolean;
      }
    | undefined;
  const handler = sessionLoginHandler(
    pool,
    redis,
    config,
    async (_redis, _token, options) => {
      receivedOptions = options;
      return {
        google_subject_id: "google-sub-123" as GoogleIdentity["google_subject_id"],
        email: "user@example.com",
        display_name: "Portal User",
        avatar_url: null,
      };
    },
    async () => "user-123" as UserId
  );

  const req = {
    headers: {
      authorization: "Bearer id-token-from-gis",
    },
  } as unknown as Request;
  const { res } = makeResponse();

  await handler(req, res);

  assert.deepEqual(receivedOptions, {
    allowedIdTokenAudiences: [
      "landing-client.apps.googleusercontent.com",
      "addon-client.apps.googleusercontent.com",
    ],
    allowUnscopedIdTokens: false,
  });
});

test("sessionMeHandler returns avatar_url from the current portal session snapshot", async () => {
  const pool = makePool();
  const handler = sessionMeHandler(pool);

  const req = {
    portalSession: {
      userId: "user-123",
      createdAt: new Date().toISOString(),
      avatarUrl: "https://lh3.googleusercontent.com/a/session-avatar",
    },
  } as unknown as Request;
  const { res, state } = makeResponse();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    signed_in: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://lh3.googleusercontent.com/a/session-avatar",
    },
    plan_type: "free",
    subscription_status: "active",
  });
});
