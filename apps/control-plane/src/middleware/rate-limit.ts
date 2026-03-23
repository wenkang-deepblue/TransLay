import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import { sendError } from "../utils/errors";

interface RateLimitConfig {
  readonly windowSeconds: number;
  readonly maxRequests: number;
  readonly keyPrefix: string;
}

/**
 * I2: Redis-based sliding window rate limiter.
 * Uses INCR + EXPIRE for simplicity (fixed window, not sliding, but adequate for MVP).
 * Identifies user by authContext.user_id if present, falls back to IP.
 */
export function rateLimitMiddleware(redis: Redis, config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier =
      req.authContext?.user_id ??
      req.ip ??
      "unknown";

    const windowKey = Math.floor(Date.now() / 1000 / config.windowSeconds);
    const key = `ratelimit:${config.keyPrefix}:${identifier}:${windowKey}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, config.windowSeconds);
      }

      if (count > config.maxRequests) {
        sendError(res, "RATE_LIMITED");
        return;
      }
    } catch (err) {
      // Rate limit failure should not block requests — log and proceed
      console.warn("Rate limit Redis error:", (err as Error).message);
    }

    next();
  };
}
