import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import { parseCookies } from "../utils/cookies";

// Augmentations consolidated in types/express.d.ts

export function portalSessionMiddleware(redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.session.cookieName];

    // No cookie present — legitimate unauthenticated request
    if (!sessionId) {
      next();
      return;
    }

    // C2: Distinguish "no cookie" (call next) from "Redis failure" (return 503)
    try {
      const data = await redis.hgetall(`portal_session:${sessionId}`);
      if (data && data.user_id) {
        req.portalSession = {
          userId: data.user_id,
          createdAt: data.created_at ?? new Date().toISOString(),
        };
      }
    } catch (err) {
      console.error("Session middleware Redis error:", (err as Error).message);
      res.status(503).json({
        error: "JOB_INTERNAL_ERROR",
        message: "Service temporarily unavailable",
      });
      return;
    }
    next();
  };
}
