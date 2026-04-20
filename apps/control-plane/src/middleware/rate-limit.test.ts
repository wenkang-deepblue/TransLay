import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import type { UserId } from "@translay/shared-contracts";
import { rateLimitMiddleware } from "./rate-limit";

type Headers = Record<string, string>;

interface MockRes {
  statusCode: number;
  body: Record<string, unknown> | null;
  headers: Headers;
}

function makeRes(): { res: Response; mock: MockRes } {
  const mock: MockRes = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code: number) {
      mock.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      mock.body = body;
      return this;
    },
    setHeader(name: string, value: string | number) {
      mock.headers[name] = String(value);
      return this;
    },
  } as unknown as Response;
  return { res, mock };
}

function makeNext(): { next: NextFunction; calls: { count: number } } {
  const calls = { count: 0 };
  const next: NextFunction = () => {
    calls.count += 1;
  };
  return { next, calls };
}

interface FakeRedisOptions {
  readonly throwOnIncr?: boolean;
  readonly initialCount?: number;
}

function makeRedis(options: FakeRedisOptions = {}): {
  redis: Redis;
  store: Map<string, number>;
} {
  const store = new Map<string, number>();
  if (options.initialCount !== undefined) {
    // Seed by inserting a known key for the test to read against — but tests
    // that need pre-load will set after constructing.
  }
  const redis = {
    async incr(key: string): Promise<number> {
      if (options.throwOnIncr) {
        throw new Error("redis down");
      }
      const current = (store.get(key) ?? 0) + 1;
      store.set(key, current);
      return current;
    },
    async expire(_key: string, _seconds: number): Promise<number> {
      return 1;
    },
  } as unknown as Redis;
  return { redis, store };
}

test("rateLimitMiddleware: under-limit request sets X-RateLimit headers and calls next", async () => {
  const { redis } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 5,
    keyPrefix: "test",
    identifierStrategy: "ip",
  });

  const req = { ip: "10.0.0.1" } as unknown as Request;
  const { res, mock } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);

  assert.equal(calls.count, 1);
  assert.equal(mock.statusCode, 200);
  assert.equal(mock.headers["X-RateLimit-Limit"], "5");
  assert.equal(mock.headers["X-RateLimit-Remaining"], "4");
  assert.ok(mock.headers["X-RateLimit-Reset"], "reset header should be set");
  assert.equal(mock.headers["Retry-After"], undefined);
});

test("rateLimitMiddleware: over-limit returns 429 with Retry-After and RATE_LIMITED body", async () => {
  const { redis } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 2,
    keyPrefix: "test",
    identifierStrategy: "ip",
  });
  const req = { ip: "10.0.0.2" } as unknown as Request;

  // Exhaust the bucket.
  for (let i = 0; i < 2; i += 1) {
    const { res } = makeRes();
    const { next } = makeNext();
    await mw(req, res, next);
  }

  // Third call should trip the limiter.
  const { res, mock } = makeRes();
  const { next, calls } = makeNext();
  await mw(req, res, next);

  assert.equal(calls.count, 0, "next must not be invoked on 429");
  assert.equal(mock.statusCode, 429);
  assert.deepEqual(mock.body, { error: "RATE_LIMITED", message: "Too many requests" });
  assert.ok(mock.headers["Retry-After"], "Retry-After header MUST be present on 429");
  assert.equal(mock.headers["X-RateLimit-Remaining"], "0");
  const retryAfter = Number(mock.headers["Retry-After"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After in [1,60], got ${retryAfter}`);
});

test('rateLimitMiddleware: identifierStrategy "user" buckets separately per user', async () => {
  const { redis, store } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 100,
    keyPrefix: "user-write",
    identifierStrategy: "user",
  });

  const reqA = {
    ip: "10.0.0.3",
    authContext: { user_id: "user-a" as UserId },
  } as unknown as Request;
  const reqB = {
    ip: "10.0.0.3",
    authContext: { user_id: "user-b" as UserId },
  } as unknown as Request;

  const { res: resA } = makeRes();
  const { next: nextA } = makeNext();
  await mw(reqA, resA, nextA);

  const { res: resB } = makeRes();
  const { next: nextB } = makeNext();
  await mw(reqB, resB, nextB);

  const keys = Array.from(store.keys());
  assert.equal(keys.length, 2, "two distinct user buckets expected");
  assert.ok(keys.some((k) => k.includes("user:user-a")));
  assert.ok(keys.some((k) => k.includes("user:user-b")));
});

test('rateLimitMiddleware: identifierStrategy "user" without auth falls back to anon:<ip>', async () => {
  const { redis, store } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: "user-write",
    identifierStrategy: "user",
  });

  const req = { ip: "10.0.0.4" } as unknown as Request;
  const { res } = makeRes();
  const { next } = makeNext();
  await mw(req, res, next);

  const keys = Array.from(store.keys());
  assert.equal(keys.length, 1);
  assert.ok(keys[0]?.includes("anon:10.0.0.4"));
});

test("rateLimitMiddleware: failOpen=true allows request when Redis throws", async () => {
  const { redis } = makeRedis({ throwOnIncr: true });
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 5,
    keyPrefix: "global",
    failOpen: true,
    identifierStrategy: "ip",
  });

  const req = { ip: "10.0.0.5" } as unknown as Request;
  const { res, mock } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);
  assert.equal(calls.count, 1, "fail-open must invoke next on Redis errors");
  assert.equal(mock.statusCode, 200);
});

test("rateLimitMiddleware: failOpen=false rejects with Retry-After when Redis throws", async () => {
  const { redis } = makeRedis({ throwOnIncr: true });
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 5,
    keyPrefix: "user-write",
    failOpen: false,
    identifierStrategy: "user",
  });

  const req = {
    ip: "10.0.0.6",
    authContext: { user_id: "user-z" as UserId },
  } as unknown as Request;
  const { res, mock } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);
  assert.equal(calls.count, 0, "fail-closed must not invoke next");
  assert.equal(mock.statusCode, 429);
  assert.deepEqual(mock.body, { error: "RATE_LIMITED", message: "Too many requests" });
  assert.ok(mock.headers["Retry-After"], "Retry-After must accompany fail-closed 429");
  assert.equal(mock.headers["X-RateLimit-Limit"], "5");
  assert.equal(mock.headers["X-RateLimit-Remaining"], "0");
  assert.ok(mock.headers["X-RateLimit-Reset"], "reset header must accompany fail-closed 429");
});

test('rateLimitMiddleware: identifierStrategy "auto" prefers user_id over IP', async () => {
  const { redis, store } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: "auto",
  });

  const req = {
    ip: "10.0.0.7",
    authContext: { user_id: "user-auto" as UserId },
  } as unknown as Request;
  const { res } = makeRes();
  const { next } = makeNext();
  await mw(req, res, next);

  const keys = Array.from(store.keys());
  assert.equal(keys.length, 1);
  assert.ok(keys[0]?.includes("user:user-auto"));
});

test('rateLimitMiddleware: identifierStrategy "auto" falls back to IP for anonymous requests', async () => {
  const { redis, store } = makeRedis();
  const mw = rateLimitMiddleware(redis, {
    windowSeconds: 60,
    maxRequests: 10,
    keyPrefix: "auto",
  });

  const req = { ip: "10.0.0.8" } as unknown as Request;
  const { res } = makeRes();
  const { next } = makeNext();
  await mw(req, res, next);

  const keys = Array.from(store.keys());
  assert.equal(keys.length, 1);
  assert.ok(keys[0]?.includes("ip:10.0.0.8"));
});
