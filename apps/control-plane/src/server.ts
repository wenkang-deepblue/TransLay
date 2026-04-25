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
import { landingConfigHandler } from "./modules/public/handler";
import {
  cancelSubscriptionHandler,
  changeSubscriptionPlanHandler,
  checkoutHandler,
  paddleWebhookHandler,
} from "./modules/billing/handler";
import {
  sessionLoginHandler,
  sessionStartHandler,
  sessionConsumeHandler,
  sessionMeHandler,
  sessionLogoutHandler,
} from "./modules/session/handler";
import {
  cancelJobHandler,
  createJobHandler,
  getJobHandler,
  pauseJobHandler,
  previewJobHandler,
  resumeJobHandler,
  sweepHostOauthTokensHandler,
} from "./modules/jobs/handler";
import { asyncHandler } from "./utils/async-handler";
import { sendError } from "./utils/errors";

const config = loadConfig();
const app = express();
const pool = getPool(config);
const redis = getRedis(config);
// Body parsing — limit size to prevent abuse
app.use(
  express.json({
    limit: "1mb",
    verify(req, _res, buf) {
      (req as Request).rawBody = Buffer.from(buf);
    },
  })
);

// Trust proxy headers (Cloud Run sits behind a load balancer)
app.set("trust proxy", 1);

// I1: CORS locked to production domain
app.use(corsMiddleware(`https://${config.domain}`));

// Track D inbound rate limiting — three buckets:
//
//   1. globalIpRateLimit   — pre-auth, IP-keyed DDoS shield. Loose ceiling so
//      multi-tenant load tests (many SAs sharing one egress IP) do not hit
//      it during normal polling. Fails open to preserve availability if
//      Redis is down.
//   2. userWriteRateLimit  — user-keyed where identity is already known, with
//      anon:<ip> fallback for pre-session writes such as /api/session/consume.
//      Job submissions / cancels are still effectively post-auth. Writes are
//      also gated by CONCURRENT_JOB_RUNNING / JOB_QUEUE_BUSY, so the bucket is
//      intentionally low. Fails closed so a Redis outage cannot silently flood
//      writes.
//   3. userReadRateLimit   — post-auth, user-keyed quota for status polls and
//      entitlement reads. Sized to comfortably accept the sidebar's ~3s
//      polling cadence with headroom. Fails closed.
const globalIpRateLimit = rateLimitMiddleware(redis, {
  windowSeconds: config.rateLimits.global.windowSeconds,
  maxRequests: config.rateLimits.global.maxRequests,
  keyPrefix: "global-ip",
  failOpen: true,
  identifierStrategy: "ip",
});

const userWriteRateLimit = rateLimitMiddleware(redis, {
  windowSeconds: config.rateLimits.userWrite.windowSeconds,
  maxRequests: config.rateLimits.userWrite.maxRequests,
  keyPrefix: "user-write",
  failOpen: false,
  identifierStrategy: "user",
});

const userReadRateLimit = rateLimitMiddleware(redis, {
  windowSeconds: config.rateLimits.userRead.windowSeconds,
  maxRequests: config.rateLimits.userRead.maxRequests,
  keyPrefix: "user-read",
  failOpen: false,
  identifierStrategy: "user",
});

const paddleWebhookRateLimit = rateLimitMiddleware(redis, {
  windowSeconds: 60,
  maxRequests: 60,
  keyPrefix: "webhook-paddle-ip",
  failOpen: false,
  identifierStrategy: "ip",
});

app.use(globalIpRateLimit);

// --- Public routes (no auth) ---
app.get("/api/health", asyncHandler(healthHandler(pool, redis)));
app.get("/api/public/landing-config", asyncHandler(landingConfigHandler(config)));

// --- Portal routes (session cookie auth) ---
const portalSession = portalSessionMiddleware(redis, config);
app.post(
  "/api/session/login",
  userWriteRateLimit,
  asyncHandler(sessionLoginHandler(pool, redis, config))
);
app.post(
  "/api/session/consume",
  userWriteRateLimit,
  asyncHandler(sessionConsumeHandler(pool, redis, config))
);
app.get(
  "/api/session/me",
  portalSession,
  userReadRateLimit,
  asyncHandler(sessionMeHandler(pool))
);
app.post(
  "/api/checkout",
  portalSession,
  userWriteRateLimit,
  asyncHandler(checkoutHandler(pool, config))
);
app.post(
  "/api/subscription/change-plan",
  portalSession,
  userWriteRateLimit,
  asyncHandler(changeSubscriptionPlanHandler(pool, redis, config))
);
app.post(
  "/api/subscription/cancel",
  portalSession,
  userWriteRateLimit,
  asyncHandler(cancelSubscriptionHandler(pool, redis, config))
);
app.post(
  "/api/session/logout",
  portalSession,
  userWriteRateLimit,
  asyncHandler(sessionLogoutHandler(redis, config))
);

// --- Add-on routes (Google token auth) ---
const googleAuth = googleAuthMiddleware(pool, redis, config);
app.get(
  "/api/entitlement",
  googleAuth,
  userReadRateLimit,
  asyncHandler(entitlementHandler(pool))
);
app.post(
  "/api/session/start",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(sessionStartHandler(redis, config))
);
app.post(
  "/api/jobs/preview",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(previewJobHandler(pool))
);
app.post(
  "/api/jobs",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(createJobHandler(pool, redis, config))
);
app.get(
  "/api/jobs/:jobId",
  googleAuth,
  userReadRateLimit,
  asyncHandler(getJobHandler(pool, redis))
);
app.post(
  "/api/jobs/:jobId/pause",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(pauseJobHandler(pool, redis, config))
);
app.post(
  "/api/jobs/:jobId/resume",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(resumeJobHandler(pool, redis, config))
);
app.post(
  "/api/jobs/:jobId/cancel",
  googleAuth,
  userWriteRateLimit,
  asyncHandler(cancelJobHandler(pool, redis, config))
);

// --- Internal maintenance routes ---
app.post(
  "/internal/sweep-oauth-tokens",
  asyncHandler(sweepHostOauthTokensHandler(pool, config))
);
app.post(
  "/api/webhooks/paddle",
  paddleWebhookRateLimit,
  asyncHandler(paddleWebhookHandler(pool, redis, config))
);

// I9: Generic error code in response, stack trace logged server-side only
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.name, err.message);
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
