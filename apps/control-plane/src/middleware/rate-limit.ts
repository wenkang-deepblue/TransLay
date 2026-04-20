import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import { sendError } from "../utils/errors";

/**
 * I2 / Track D inbound rate limiter.
 *
 * Three identifier strategies are supported so the same Redis-backed limiter
 * can be reused for distinctly scoped buckets:
 *
 *   - "auto":  legacy fallback chain `user_id ?? portal session ?? req.ip`.
 *              Used by the pre-auth global bucket so anonymous requests are
 *              still throttled per IP while authenticated requests get a
 *              user-scoped key. Preserves backwards compatibility.
 *   - "ip":    always keys on `req.ip`. Used for pre-auth shields where the
 *              throttle must apply per source IP regardless of any later
 *              auth that may attach a user.
 *   - "user":  prefers `user_id`/portal session id. If neither is present the
 *              middleware short-circuits with `unknown:<ip>` so a misconfigured
 *              route never silently drops to a global bucket.
 *
 * Every 429 response is annotated with `Retry-After` (in seconds until the
 * window resets) plus `X-RateLimit-*` headers so clients can implement
 * deterministic backoff without guessing.
 */
type IdentifierStrategy = "auto" | "ip" | "user";

interface RateLimitConfig {
  readonly windowSeconds: number;
  readonly maxRequests: number;
  readonly keyPrefix: string;
  readonly failOpen?: boolean;
  readonly identifierStrategy?: IdentifierStrategy;
}

function resolveIdentifier(
  req: Request,
  strategy: IdentifierStrategy
): string {
  const ip = req.ip ?? "unknown";
  const userId = req.authContext?.user_id ?? req.portalSession?.userId ?? null;

  switch (strategy) {
    case "ip":
      return `ip:${ip}`;
    case "user":
      return userId ? `user:${userId}` : `anon:${ip}`;
    case "auto":
    default:
      return userId ? `user:${userId}` : `ip:${ip}`;
  }
}

function setRateLimitHeaders(
  res: Response,
  config: RateLimitConfig,
  remaining: number,
  resetAtSeconds: number
): void {
  // Best-effort: never let header math throw and break the request path.
  try {
    res.setHeader("X-RateLimit-Limit", String(config.maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    res.setHeader("X-RateLimit-Reset", String(resetAtSeconds));
  } catch {
    /* ignore header errors — body still carries the error code */
  }
}

function setRetryAfter(res: Response, seconds: number): void {
  try {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(seconds))));
  } catch {
    /* ignore */
  }
}

export function rateLimitMiddleware(redis: Redis, config: RateLimitConfig) {
  const strategy: IdentifierStrategy = config.identifierStrategy ?? "auto";

  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = resolveIdentifier(req, strategy);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(nowSeconds / config.windowSeconds);
    const windowStart = windowIndex * config.windowSeconds;
    const windowEnd = windowStart + config.windowSeconds;
    const secondsUntilReset = Math.max(1, windowEnd - nowSeconds);
    const key = `ratelimit:${config.keyPrefix}:${identifier}:${windowIndex}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, config.windowSeconds);
      }

      const remaining = config.maxRequests - count;
      setRateLimitHeaders(res, config, remaining, windowEnd);

      if (count > config.maxRequests) {
        setRetryAfter(res, secondsUntilReset);
        sendError(res, "RATE_LIMITED");
        return;
      }
    } catch (err) {
      // Public/global throttles may fail open for availability. Auth/session-scoped
      // throttles should fail closed because they protect write-heavy control paths.
      console.warn("Rate limit Redis error:", (err as Error).message);
      if (!config.failOpen) {
        setRateLimitHeaders(
          res,
          config,
          0,
          nowSeconds + config.windowSeconds
        );
        setRetryAfter(res, config.windowSeconds);
        sendError(res, "RATE_LIMITED");
        return;
      }
    }

    next();
  };
}
