import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";

// I7: Health check verifies DB and Redis connectivity.
// Subsystem status logged server-side only — never exposed to clients.
export function healthHandler(pool: Pool, redis: Redis) {
  return async (_req: Request, res: Response) => {
    try {
      const [dbOk, redisOk] = await Promise.all([
        pool.query("SELECT 1").then(() => true).catch(() => false),
        redis.ping().then((r) => r === "PONG").catch(() => false),
      ]);

      if (!dbOk || !redisOk) {
        console.error(`Health check failed — db: ${dbOk}, redis: ${redisOk}`);
        res.status(503).json({ ok: false, time: new Date().toISOString() });
        return;
      }

      res.json({ ok: true, time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, time: new Date().toISOString() });
    }
  };
}
