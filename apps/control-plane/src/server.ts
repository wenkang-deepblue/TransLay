import express, { type Request, type Response, type NextFunction } from "express";
import { loadConfig } from "@translay/shared-config";
import { getPool, shutdownPool } from "./db/pool";
import { getRedis, shutdownRedis } from "./cache/redis";
import { corsMiddleware } from "./middleware/cors";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { googleAuthMiddleware } from "./middleware/auth";
import { portalSessionMiddleware } from "./middleware/session";
import { healthHandler } from "./modules/health/handler";
import { entitlementHandler } from "./modules/entitlement/handler";
import {
  sessionStartHandler,
  sessionConsumeHandler,
  sessionMeHandler,
  sessionLogoutHandler,
} from "./modules/session/handler";
import { createJobHandler, getJobHandler } from "./modules/jobs/handler";
import { asyncHandler } from "./utils/async-handler";
import { sendError } from "./utils/errors";

const config = loadConfig();
const app = express();
const pool = getPool(config);
const redis = getRedis(config);

// Body parsing — limit size to prevent abuse
app.use(express.json({ limit: "1mb" }));

// Trust proxy headers (Cloud Run sits behind a load balancer)
app.set("trust proxy", true);

// I1: CORS locked to production domain
app.use(corsMiddleware(`https://${config.domain}`));

// I2: Global rate limit (60 req/min per user/IP)
app.use(rateLimitMiddleware(redis, { windowSeconds: 60, maxRequests: 60, keyPrefix: "global" }));

// --- Public routes (no auth) ---
app.get("/api/health", asyncHandler(healthHandler(pool, redis)));

// --- Portal routes (session cookie auth) ---
const portalSession = portalSessionMiddleware(redis, config);
app.post("/api/session/consume", asyncHandler(sessionConsumeHandler(pool, redis, config)));
app.get("/api/session/me", portalSession, asyncHandler(sessionMeHandler(pool)));
app.post("/api/session/logout", portalSession, asyncHandler(sessionLogoutHandler(redis, config)));

// --- Add-on routes (Google token auth) ---
const googleAuth = googleAuthMiddleware(pool, redis);
app.get("/api/entitlement", googleAuth, asyncHandler(entitlementHandler(pool)));
app.post("/api/session/start", googleAuth, asyncHandler(sessionStartHandler(redis, config)));
app.post("/api/jobs", googleAuth, asyncHandler(createJobHandler(pool, redis, config)));
app.get("/api/jobs/:jobId", googleAuth, asyncHandler(getJobHandler(pool, redis)));

// I9: Generic error code in response, stack trace logged server-side only
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.stack ?? err.message);
  sendError(res, "INTERNAL_ERROR");
});

// --- Start server ---
const server = app.listen(config.port, () => {
  console.log(`TransLay control-plane listening on port ${config.port}`);
});

server.on("error", (err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});

// S3: Promise.allSettled ensures one failing cleanup doesn't block the other
async function shutdown() {
  console.log("Shutting down...");
  server.close();
  await Promise.allSettled([shutdownPool(), shutdownRedis()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
