import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import {
  cancelSubscriptionHandler,
  changeSubscriptionPlanHandler,
  checkoutHandler,
  paddleWebhookHandler,
} from "./handler";

function makeResponse(): { res: Response; state: { statusCode: number; body: unknown } } {
  const state = {
    statusCode: 200,
    body: null as unknown,
  };

  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
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
      cookieName: "__session",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    domain: "your-domain.example.com",
    publicAuth: {
      googleWebClientId: "google-client-id",
      googleIdTokenAudiences: ["google-client-id"],
    },
    billing: {
      providerName: "paddle",
      paddle: {
        environment: "sandbox",
        clientToken: "test_client_token",
        apiKey: "pdl_test_api_key",
        webhookSecret: "whsec_test_secret",
        priceIds: {
          pro_monthly: "pri_monthly_123",
          pro_yearly: "pri_yearly_456",
        },
        priceAmounts: {
          pro_monthly: 999,
          pro_yearly: 11999,
        },
        webhookToleranceSeconds: 300,
      },
    },
    entitlementCacheTtl: 300,
    jobs: { maxGlobalInFlightJobs: 50 },
    rateLimits: {
      global: { windowSeconds: 60, maxRequests: 1200 },
      userWrite: { windowSeconds: 60, maxRequests: 30 },
      userRead: { windowSeconds: 60, maxRequests: 120 },
    },
    security: {
      kmsKeyName: null,
      internalCronSecret: null,
    },
  } as const;
}

test("checkoutHandler returns Paddle overlay config for a signed-in free user", async () => {
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
              id: "sub_free",
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

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;

  const { res, state } = makeResponse();
  const handler = checkoutHandler(pool, makeConfig());
  await handler(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
      },
      body: {
        plan_type: "pro_monthly",
      },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    provider_name: "paddle",
    price_id: "pri_monthly_123",
    custom_data: {
      user_id: "user-123",
      product_type: "subscription",
      sku: "pro_monthly",
    },
  });
});

test("checkoutHandler blocks duplicate paid subscriptions", async () => {
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
              id: "sub_paid",
              user_id: params[0],
              plan_type: "pro_monthly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: null,
              current_period_end: null,
              cancel_at_period_end: false,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;

  const { res, state } = makeResponse();
  await checkoutHandler(pool, makeConfig())(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
      },
      body: { plan_type: "pro_yearly" },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, {
    error: "ACCESS_DENIED",
    message: "A paid subscription already exists for this account. Use the billing page to change it.",
  });
});

test("paddleWebhookHandler rejects invalid signatures", async () => {
  const pool = {
    async query() {
      throw new Error("Should not query database for invalid signature");
    },
  } as unknown as Pool;

  const redis = {
    async del() {
      return 1;
    },
  } as unknown as Redis;

  const { res, state } = makeResponse();
  await paddleWebhookHandler(pool, redis, makeConfig())(
    {
      headers: {
        "paddle-signature": "ts=1;h1=deadbeef",
      },
      rawBody: Buffer.from("{}"),
      body: {},
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, {
    error: "WEBHOOK_SIGNATURE_INVALID",
    message: "Webhook signature verification failed",
  });
});

test("paddleWebhookHandler upserts a subscription and payment order for valid events", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);

      if (sql.includes("INSERT INTO webhook_events")) {
        return {
          rows: [
            {
              id: "wh_1",
              provider_name: "paddle",
              provider_event_id: "evt_1",
              event_type: "transaction.completed",
              signature_valid: true,
              processed: false,
              processing_error: null,
              received_at: new Date(),
              processed_at: null,
              inserted: true,
            },
          ],
        };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "wh_1",
              provider_name: "paddle",
              provider_event_id: "evt_1",
              event_type: "transaction.completed",
              signature_valid: true,
              processed: false,
              processing_error: null,
              received_at: new Date(),
              processed_at: null,
            },
          ],
        };
      }

      if (sql.includes("FROM subscriptions") && sql.includes("provider_subscription_id")) {
        return { rows: [] };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        return {
          rows: [
            {
              id: "sub_row_1",
              user_id: "user-123",
              plan_type: "pro_monthly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: null,
              cancel_at_period_end: false,
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO payment_orders")) {
        return {
          rows: [
            {
              id: "ord_1",
              user_id: "user-123",
              provider_name: "paddle",
              product_type: "subscription",
              sku: "pro_monthly",
              amount: "9.99",
              currency: "USD",
              provider_checkout_id: "che_123",
              provider_transaction_id: "txn_123",
              provider_subscription_id: "sub_123",
              status: "paid",
              created_at: new Date(),
              paid_at: new Date(),
              refunded_at: null,
              updated_at: new Date(),
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE webhook_events")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
    async connect() {
      return this;
    },
    release() {},
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const body = {
    event_id: "evt_1",
    event_type: "transaction.completed",
    data: {
      id: "txn_123",
      customer_id: "ctm_123",
      subscription_id: "sub_123",
      checkout_id: "che_123",
      custom_data: {
        user_id: "user-123",
        product_type: "subscription",
        sku: "pro_monthly",
      },
      details: {
        totals: {
          grand_total: "999",
          currency_code: "USD",
        },
      },
      billed_at: "2026-04-23T12:00:00.000Z",
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHmac("sha256", makeConfig().billing.paddle.webhookSecret)
    .update(`${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  const { res, state } = makeResponse();
  await paddleWebhookHandler(pool, redis, makeConfig())(
    {
      headers: {
        "paddle-signature": `ts=${timestamp};h1=deadbeef;h1=${digest}`,
      },
      rawBody,
      body,
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.ok(
    queries.some(
      (sql) =>
        sql.startsWith("INSERT INTO payment_orders")
        && sql.includes("ON CONFLICT (provider_name, provider_transaction_id)")
        && sql.includes("WHERE provider_transaction_id IS NOT NULL")
    ),
    "expected payment order upsert query"
  );
  assert.ok(
    queries.some(
      (sql) =>
        sql.startsWith("INSERT INTO subscriptions")
        && sql.includes("ON CONFLICT (provider_name, provider_subscription_id)")
        && sql.includes("WHERE provider_subscription_id IS NOT NULL")
    ),
    "expected subscription upsert query"
  );
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("paddleWebhookHandler treats concurrent duplicate inserts as idempotent", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("INSERT INTO webhook_events")) {
        return {
          rows: [
            {
              id: "wh_1",
              provider_name: "paddle",
              provider_event_id: "evt_1",
              event_type: "transaction.completed",
              signature_valid: true,
              processed: true,
              processing_error: null,
              received_at: new Date(),
              processed_at: new Date(),
              inserted: false,
            },
          ],
        };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "wh_1",
              provider_name: "paddle",
              provider_event_id: "evt_1",
              event_type: "transaction.completed",
              signature_valid: true,
              processed: true,
              processing_error: null,
              received_at: new Date(),
              processed_at: new Date(),
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async connect() {
      return this;
    },
    release() {},
  } as unknown as Pool;

  const redis = {
    async del() {
      return 1;
    },
  } as unknown as Redis;

  const body = {
    event_id: "evt_1",
    event_type: "transaction.completed",
    data: {
      id: "txn_123",
      custom_data: {
        user_id: "user-123",
        product_type: "subscription",
        sku: "pro_monthly",
      },
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHmac("sha256", makeConfig().billing.paddle.webhookSecret)
    .update(`${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  const { res, state } = makeResponse();
  await paddleWebhookHandler(pool, redis, makeConfig())(
    {
      headers: {
        "paddle-signature": `ts=${timestamp};h1=${digest}`,
      },
      rawBody,
      body,
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true, duplicate: true });
  assert.ok(queries.some((sql) => sql.includes("FOR UPDATE")));
});

test("paddleWebhookHandler applies terminal subscription status even when Paddle omits price items", async () => {
  const subscriptionUpsertParams: unknown[][] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("INSERT INTO webhook_events")) {
        return {
          rows: [{
            id: "wh_cancel",
            provider_name: "paddle",
            provider_event_id: "evt_cancel",
            event_type: "subscription.canceled",
            signature_valid: true,
            processed: false,
            processing_error: null,
            received_at: new Date(),
            processed_at: null,
            inserted: true,
          }],
        };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "wh_cancel",
            provider_name: "paddle",
            provider_event_id: "evt_cancel",
            event_type: "subscription.canceled",
            signature_valid: true,
            processed: false,
            processing_error: null,
            received_at: new Date(),
            processed_at: null,
          }],
        };
      }

      if (sql.includes("FROM subscriptions") && sql.includes("provider_subscription_id")) {
        return {
          rows: [{
            id: "sub_row_1",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: true,
          }],
        };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        subscriptionUpsertParams.push(params ?? []);
        return {
          rows: [{
            id: "sub_row_1",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "canceled",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      if (sql.startsWith("UPDATE webhook_events")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
    async connect() {
      return this;
    },
    release() {},
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const body = {
    event_id: "evt_cancel",
    event_type: "subscription.canceled",
    data: {
      id: "sub_123",
      status: "canceled",
      customer_id: "ctm_123",
      current_billing_period: {
        starts_at: "2026-04-23T12:00:00.000Z",
        ends_at: "2026-05-23T12:00:00.000Z",
      },
      items: [],
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHmac("sha256", makeConfig().billing.paddle.webhookSecret)
    .update(`${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  const { res, state } = makeResponse();
  await paddleWebhookHandler(pool, redis, makeConfig())(
    {
      headers: {
        "paddle-signature": `ts=${timestamp};h1=${digest}`,
      },
      rawBody,
      body,
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.equal(subscriptionUpsertParams[0]?.[1], "pro_monthly");
  assert.equal(subscriptionUpsertParams[0]?.[2], "canceled");
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("changeSubscriptionPlanHandler asks for upgrade charge confirmation before billing", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [{
            id: "user-123",
            google_subject_id: "google-sub-123",
            email: "user@example.com",
            display_name: "Portal User",
          }],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const redis = { async del() { return 1; } } as unknown as Redis;
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2026-05-23T12:00:00.000Z",
          },
          items: [{ price: { id: "pri_monthly_123" }, quantity: 1 }],
          scheduled_change: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
      body: { plan_type: "pro_yearly" },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(fetchCalls, [
    { url: "https://sandbox-api.paddle.com/subscriptions/sub_123", method: "GET" },
  ]);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_monthly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2026-05-23T12:00:00.000Z",
      cancel_at_period_end: false,
    },
    billing_action: {
      type: "confirm_upgrade_charge",
      amount: 11000,
      formatted_amount: "$110.00",
    },
  });
});

test("changeSubscriptionPlanHandler upgrades a monthly subscription to yearly", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);

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

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [
            {
              id: "sub_paid",
              user_id: "user-123",
              plan_type: "pro_monthly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: new Date("2026-05-23T12:00:00.000Z"),
              cancel_at_period_end: false,
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        return {
          rows: [
            {
              id: "sub_paid",
              user_id: "user-123",
              plan_type: "pro_yearly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: new Date("2027-04-23T12:00:00.000Z"),
              cancel_at_period_end: false,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const fetchCalls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    fetchCalls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : "",
    });

    if (method === "GET") {
      return new Response(
        JSON.stringify({
          data: {
            id: "sub_123",
            status: "active",
            customer_id: "ctm_123",
            current_billing_period: {
              starts_at: "2026-04-23T12:00:00.000Z",
              ends_at: "2026-05-23T12:00:00.000Z",
            },
            items: [
              {
                price: { id: "pri_monthly_123" },
                quantity: 1,
              },
            ],
            scheduled_change: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (method === "POST" && url.endsWith("/charge")) {
      return new Response(
        JSON.stringify({
          data: {
            id: "sub_123",
            status: "active",
            customer_id: "ctm_123",
            current_billing_period: {
              starts_at: "2026-04-23T12:00:00.000Z",
              ends_at: "2026-05-23T12:00:00.000Z",
            },
            items: [{ price: { id: "pri_monthly_123" }, quantity: 1 }],
            scheduled_change: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2027-04-23T12:00:00.000Z",
          },
          items: [
            {
              price: { id: "pri_yearly_456" },
              quantity: 1,
            },
          ],
          scheduled_change: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
      body: {
        plan_type: "pro_yearly",
        confirm_upgrade_charge: true,
      },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_yearly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2027-04-23T12:00:00.000Z",
      cancel_at_period_end: false,
    },
    billing_action: {
      type: "upgrade_charged",
      amount: 11000,
      formatted_amount: "$110.00",
    },
  });
  assert.equal(fetchCalls.length, 3);
  assert.equal(fetchCalls[0]?.url, "https://sandbox-api.paddle.com/subscriptions/sub_123");
  assert.equal(fetchCalls[1]?.url, "https://sandbox-api.paddle.com/subscriptions/sub_123/charge");
  assert.equal(fetchCalls[1]?.method, "POST");
  assert.match(fetchCalls[1]?.body ?? "", /"amount":"11000"/);
  assert.match(fetchCalls[1]?.body ?? "", /"on_payment_failure":"prevent_change"/);
  assert.equal(fetchCalls[2]?.method, "PATCH");
  assert.match(fetchCalls[2]?.body ?? "", /"proration_billing_mode":"do_not_bill"/);
  assert.doesNotMatch(fetchCalls[2]?.body ?? "", /"scheduled_change"/);
  assert.match(fetchCalls[2]?.body ?? "", /"price_id":"pri_yearly_456"/);
  assert.match(fetchCalls[2]?.body ?? "", /"translay_entitlement_period_start":"2026-04-23T12:00:00.000Z"/);
  assert.match(fetchCalls[2]?.body ?? "", /"translay_entitlement_period_end":"2027-04-23T12:00:00.000Z"/);
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("changeSubscriptionPlanHandler clears scheduled cancellation while upgrading monthly to yearly", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [{
            id: "user-123",
            google_subject_id: "google-sub-123",
            email: "user@example.com",
            display_name: "Portal User",
          }],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: true,
          }],
        };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_yearly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2027-04-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const fetchCalls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    fetchCalls.push({ url, method, body });

    if (method === "POST" && url.endsWith("/charge")) {
      return new Response(
        JSON.stringify({ data: { id: "txn_upgrade_123", status: "paid" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const isUpgradePatch = method === "PATCH" && body.includes("pri_yearly_456");
    const responseData = isUpgradePatch
      ? {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2026-05-23T12:00:00.000Z",
          },
          custom_data: {
            user_id: "user-123",
            sku: "pro_yearly",
            translay_entitlement_period_start: "2026-04-23T12:00:00.000Z",
            translay_entitlement_period_end: "2027-04-23T12:00:00.000Z",
          },
          items: [{ price: { id: "pri_yearly_456" }, quantity: 1 }],
          scheduled_change: null,
        }
      : {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2026-05-23T12:00:00.000Z",
          },
          items: [{ price: { id: "pri_monthly_123" }, quantity: 1 }],
          scheduled_change: method === "GET" ? { action: "cancel" } : null,
        };

    return new Response(
      JSON.stringify({ data: responseData }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
      body: { plan_type: "pro_yearly", confirm_upgrade_charge: true },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_yearly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2027-04-23T12:00:00.000Z",
      cancel_at_period_end: false,
    },
    billing_action: {
      type: "upgrade_charged",
      amount: 11000,
      formatted_amount: "$110.00",
    },
  });
  assert.equal(fetchCalls.length, 4);
  assert.equal(fetchCalls[0]?.method, "GET");
  assert.equal(fetchCalls[1]?.method, "POST");
  assert.equal(fetchCalls[1]?.url, "https://sandbox-api.paddle.com/subscriptions/sub_123/charge");
  assert.equal(fetchCalls[2]?.method, "PATCH");
  assert.match(fetchCalls[2]?.body ?? "", /"scheduled_change":null/);
  assert.doesNotMatch(fetchCalls[2]?.body ?? "", /"items"/);
  assert.equal(fetchCalls[3]?.method, "PATCH");
  assert.match(fetchCalls[3]?.body ?? "", /"price_id":"pri_yearly_456"/);
  assert.doesNotMatch(fetchCalls[3]?.body ?? "", /"scheduled_change"/);
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("changeSubscriptionPlanHandler does not patch the subscription when upgrade charge fails", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [{
            id: "user-123",
            google_subject_id: "google-sub-123",
            email: "user@example.com",
            display_name: "Portal User",
          }],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const redis = {
    async del() {
      throw new Error("Entitlement cache should not be invalidated");
    },
  } as unknown as Redis;

  const fetchCalls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    fetchCalls.push({ url, method, body });

    if (method === "POST" && url.endsWith("/charge")) {
      return new Response(
        JSON.stringify({ error: { detail: "Upgrade payment was declined" } }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }

    const isYearly = body.includes("pri_yearly_456");
    return new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: isYearly ? "2027-04-23T12:00:00.000Z" : "2026-05-23T12:00:00.000Z",
          },
          custom_data: isYearly
            ? {
                user_id: "user-123",
                sku: "pro_yearly",
                translay_entitlement_period_start: "2026-04-23T12:00:00.000Z",
                translay_entitlement_period_end: "2027-04-23T12:00:00.000Z",
              }
            : { user_id: "user-123", sku: "pro_monthly" },
          items: [{ price: { id: isYearly ? "pri_yearly_456" : "pri_monthly_123" }, quantity: 1 }],
          scheduled_change: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
      },
      body: { plan_type: "pro_yearly", confirm_upgrade_charge: true },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.body, {
    error: "SERVICE_UNAVAILABLE",
    message: "Upgrade payment was declined",
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.method, "GET");
  assert.equal(fetchCalls[1]?.method, "POST");
  assert.equal(fetchCalls[1]?.url, "https://sandbox-api.paddle.com/subscriptions/sub_123/charge");
});

test("changeSubscriptionPlanHandler resumes a canceling subscription on the same plan", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [{
            id: "user-123",
            google_subject_id: "google-sub-123",
            email: "user@example.com",
            display_name: "Portal User",
          }],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: true,
          }],
        };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_monthly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2026-05-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const fetchCalls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2026-05-23T12:00:00.000Z",
          },
          items: [{ price: { id: "pri_monthly_123" }, quantity: 1 }],
          scheduled_change: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
      body: { plan_type: "pro_monthly" },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_monthly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2026-05-23T12:00:00.000Z",
      cancel_at_period_end: false,
    },
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "https://sandbox-api.paddle.com/subscriptions/sub_123");
  assert.equal(fetchCalls[0]?.method, "PATCH");
  assert.match(fetchCalls[0]?.body ?? "", /"scheduled_change":null/);
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("changeSubscriptionPlanHandler rejects switching an annual commitment to monthly", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM users WHERE id = $1")) {
        return {
          rows: [{
            id: "user-123",
            google_subject_id: "google-sub-123",
            email: "user@example.com",
            display_name: "Portal User",
          }],
        };
      }

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [{
            id: "sub_paid",
            user_id: "user-123",
            plan_type: "pro_yearly",
            status: "active",
            provider_name: "paddle",
            provider_customer_id: "ctm_123",
            provider_subscription_id: "sub_123",
            current_period_start: new Date("2026-04-23T12:00:00.000Z"),
            current_period_end: new Date("2027-04-23T12:00:00.000Z"),
            cancel_at_period_end: false,
          }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;
  const redis = { async del() { return 1; } } as unknown as Redis;
  let fetchCalled = false;
  const fetchImpl: typeof fetch = async () => {
    fetchCalled = true;
    return new Response("{}");
  };

  const { res, state } = makeResponse();
  await changeSubscriptionPlanHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
      },
      body: { plan_type: "pro_monthly" },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, {
    error: "ACCESS_DENIED",
    message: "Annual commitment is active. Monthly subscription is unavailable until the annual period ends.",
  });
  assert.equal(fetchCalled, false);
});

test("cancelSubscriptionHandler schedules cancellation at period end", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
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

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [
            {
              id: "sub_paid",
              user_id: "user-123",
              plan_type: "pro_yearly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: new Date("2027-04-23T12:00:00.000Z"),
              cancel_at_period_end: false,
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO subscriptions")) {
        return {
          rows: [
            {
              id: "sub_paid",
              user_id: "user-123",
              plan_type: "pro_yearly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: new Date("2027-04-23T12:00:00.000Z"),
              cancel_at_period_end: true,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const deletedKeys: string[] = [];
  const redis = {
    async del(key: string) {
      deletedKeys.push(key);
      return 1;
    },
  } as unknown as Redis;

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2027-04-23T12:00:00.000Z",
          },
          items: [
            {
              price: { id: "pri_yearly_456" },
              quantity: 1,
            },
          ],
          scheduled_change: {
            action: "cancel",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const { res, state } = makeResponse();
  await cancelSubscriptionHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_yearly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2027-04-23T12:00:00.000Z",
      cancel_at_period_end: true,
    },
  });
  assert.deepEqual(deletedKeys, ["entitlement:user-123"]);
});

test("cancelSubscriptionHandler returns Paddle cancel portal link when API key lacks cancel permission", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
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

      if (sql.includes("FROM subscriptions")) {
        return {
          rows: [
            {
              id: "sub_paid",
              user_id: "user-123",
              plan_type: "pro_monthly",
              status: "active",
              provider_name: "paddle",
              provider_customer_id: "ctm_123",
              provider_subscription_id: "sub_123",
              current_period_start: new Date("2026-04-23T12:00:00.000Z"),
              current_period_end: new Date("2026-05-23T12:00:00.000Z"),
              cancel_at_period_end: false,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params ?? [])}`);
    },
  } as unknown as Pool;

  const redis = {
    async del() {
      return 1;
    },
  } as unknown as Redis;

  const fetchCalls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    fetchCalls.push(String(url));
    if (String(url).endsWith("/subscriptions/sub_123/cancel")) {
      return new Response(
        JSON.stringify({
          error: {
            detail: "not authorized to create subscription-cancel",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          id: "sub_123",
          status: "active",
          customer_id: "ctm_123",
          current_billing_period: {
            starts_at: "2026-04-23T12:00:00.000Z",
            ends_at: "2026-05-23T12:00:00.000Z",
          },
          management_urls: {
            cancel: "https://customer-portal.paddle.com/cancel/sub_123?token=temp",
          },
          items: [
            {
              price: { id: "pri_monthly_123" },
              quantity: 1,
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const { res, state } = makeResponse();
  await cancelSubscriptionHandler(pool, redis, makeConfig(), fetchImpl)(
    {
      portalSession: {
        userId: "user-123",
        createdAt: new Date().toISOString(),
        avatarUrl: "https://example.com/avatar.png",
      },
    } as unknown as Request,
    res
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(fetchCalls, [
    "https://sandbox-api.paddle.com/subscriptions/sub_123/cancel",
    "https://sandbox-api.paddle.com/subscriptions/sub_123",
  ]);
  assert.deepEqual(state.body, {
    ok: true,
    user: {
      google_subject_id: "google-sub-123",
      email: "user@example.com",
      display_name: "Portal User",
      avatar_url: "https://example.com/avatar.png",
    },
    plan_type: "pro_monthly",
    subscription_status: "active",
    subscription: {
      provider_name: "paddle",
      current_period_start: "2026-04-23T12:00:00.000Z",
      current_period_end: "2026-05-23T12:00:00.000Z",
      cancel_at_period_end: false,
    },
    billing_action: {
      type: "redirect",
      url: "https://customer-portal.paddle.com/cancel/sub_123?token=temp",
    },
  });
});
