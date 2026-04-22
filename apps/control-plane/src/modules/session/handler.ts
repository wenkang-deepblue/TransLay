import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  GoogleIdentity,
  SessionLoginResponse,
  SessionStartResponse,
  SessionConsumeResponse,
  SessionMeResponse,
  UserId,
} from "@translay/shared-contracts";
import { resolveGoogleIdentityWithCache } from "../../middleware/auth";
import { upsertUser } from "../../repositories/user-repo";
import { findUserById } from "../../repositories/user-repo";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { sendError } from "../../utils/errors";
import { parseCookies } from "../../utils/cookies";
import { assertMultiOk } from "../../utils/redis-helpers";

const TICKET_TTL = 60;
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

function setSessionNoStoreHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie, Authorization");
}

function generateSecureId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * C1: Lua script for atomic ticket consumption.
 * C3: Returns the consumed user/session snapshot directly to avoid TOCTOU.
 * Returns: JSON payload = consumed successfully, "0" = already consumed,
 * "-1" = ticket not found, "-2" = corrupted ticket payload
 */
const CONSUME_TICKET_LUA = `
local key = KEYS[1]
local exists = redis.call('EXISTS', key)
if exists == 0 then return "-1" end
local consumed = redis.call('HGET', key, 'consumed')
if consumed == '1' then return "0" end
local user_id = redis.call('HGET', key, 'user_id')
if not user_id then return "-2" end
local avatar_url = redis.call('HGET', key, 'avatar_url')
redis.call('HSET', key, 'consumed', '1')
redis.call('EXPIRE', key, 5)
return cjson.encode({ user_id = user_id, avatar_url = avatar_url or '' })
`;

interface PortalSessionSeed {
  readonly userId: UserId | string;
  readonly avatarUrl: string | null;
}

function buildPortalSessionCookieValue(
  config: AppConfig,
  sessionId: string,
  maxAgeSeconds: number
): string {
  return `${config.session.cookieName}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function appendSetCookieHeader(res: Response, cookieValue: string): void {
  const existing =
    typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [String(existing), cookieValue]);
}

function buildPortalUserSummary(
  user: {
    google_subject_id: string;
    email: string | null;
    display_name: string | null;
  },
  avatarUrl: string | null
) {
  return {
    google_subject_id: user.google_subject_id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: avatarUrl,
  };
}

async function createPortalSession(
  redis: Redis,
  seed: PortalSessionSeed
): Promise<string> {
  const sessionId = generateSecureId();
  const sessionKey = `portal_session:${sessionId}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
  const payload: Record<string, string> = {
    user_id: seed.userId,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };
  if (seed.avatarUrl) {
    payload.avatar_url = seed.avatarUrl;
  }

  const results = await redis
    .multi()
    .hset(sessionKey, payload)
    .expire(sessionKey, SESSION_TTL)
    .exec();
  assertMultiOk(results, "portal session create");

  return sessionId;
}

function setPortalSessionCookie(res: Response, config: AppConfig, sessionId: string): void {
  appendSetCookieHeader(
    res,
    buildPortalSessionCookieValue(config, sessionId, SESSION_TTL)
  );
}

function clearPortalSessionCookie(res: Response, config: AppConfig): void {
  appendSetCookieHeader(res, buildPortalSessionCookieValue(config, "", 0));
}

async function deletePreviousPortalSession(
  req: Request,
  redis: Redis,
  config: AppConfig,
  nextSessionId: string
): Promise<void> {
  const cookies = parseCookies(req.headers?.cookie);
  const previousSessionId = cookies[config.session.cookieName];
  if (!previousSessionId || previousSessionId === nextSessionId) {
    return;
  }

  try {
    await redis.del(`portal_session:${previousSessionId}`);
  } catch (err) {
    console.warn(
      "Failed to delete previous portal session:",
      (err as Error).message
    );
  }
}

function buildPortalSessionResponse(
  user: {
    google_subject_id: string;
    email: string | null;
    display_name: string | null;
  },
  planType: string,
  subscriptionStatus: string,
  avatarUrl: string | null
): SessionConsumeResponse | SessionLoginResponse {
  return {
    ok: true,
    user: buildPortalUserSummary(user, avatarUrl),
    plan_type: planType as SessionConsumeResponse["plan_type"],
    subscription_status: subscriptionStatus as SessionConsumeResponse["subscription_status"],
  };
}

export function sessionStartHandler(redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    setSessionNoStoreHeaders(res);
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const { redirect_path, reason } = req.body ?? {};
    const path = typeof redirect_path === "string" ? redirect_path : "/pricing";
    const ticketReason = typeof reason === "string" ? reason : "upgrade_click";

    const ticket = `ttk_${generateSecureId()}`;
    const ticketKey = `portal_ticket:${ticket}`;
    const ticketPayload: Record<string, string> = {
      user_id: auth.user_id,
      redirect_path: path,
      reason: ticketReason,
      consumed: "0",
    };
    if (auth.identity.avatar_url) {
      ticketPayload.avatar_url = auth.identity.avatar_url;
    }

    const results = await redis
      .multi()
      .hset(ticketKey, ticketPayload)
      .expire(ticketKey, TICKET_TTL)
      .exec();

    assertMultiOk(results, "session/start ticket create");

    const portalUrl = `https://${config.domain}${path}?ticket=${ticket}`;

    const response: SessionStartResponse = {
      portal_url: portalUrl,
      ticket_expires_in_seconds: TICKET_TTL,
    };

    res.json(response);
  };
}

export function sessionConsumeHandler(pool: Pool, redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    setSessionNoStoreHeaders(res);
    const { ticket } = req.body ?? {};
    if (!ticket || typeof ticket !== "string") {
      sendError(res, "INVALID_TICKET", "Ticket is required");
      return;
    }

    const ticketKey = `portal_ticket:${ticket}`;

    // C1+C3: Atomic consume via Lua — returns user_id directly, no separate HGET needed
    let consumeResult: string;
    try {
      consumeResult = await redis.eval(
        CONSUME_TICKET_LUA,
        1,
        ticketKey
      ) as string;
    } catch (err) {
      // I11: Redis failure during ticket consumption
      console.error("Ticket consume Redis error:", (err as Error).message);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    if (consumeResult === "-1") {
      sendError(res, "INVALID_TICKET");
      return;
    }
    if (consumeResult === "0") {
      sendError(res, "TICKET_ALREADY_CONSUMED");
      return;
    }
    if (consumeResult === "-2") {
      console.error("Ticket payload missing user_id:", ticketKey);
      sendError(res, "JOB_INTERNAL_ERROR", "Ticket payload is corrupted");
      return;
    }

    let consumedTicket: { user_id: string; avatar_url?: string };
    try {
      consumedTicket = JSON.parse(consumeResult) as {
        user_id: string;
        avatar_url?: string;
      };
    } catch (err) {
      console.error("Ticket consume payload parse error:", (err as Error).message);
      sendError(res, "JOB_INTERNAL_ERROR", "Ticket payload is corrupted");
      return;
    }

    if (!consumedTicket.user_id) {
      sendError(res, "JOB_INTERNAL_ERROR", "Ticket payload is corrupted");
      return;
    }

    const userId = consumedTicket.user_id;

    const user = await findUserById(pool, userId);
    if (!user) {
      sendError(res, "INVALID_TICKET");
      return;
    }

    let sub;
    try {
      sub = await getActiveSubscription(pool, user.id);
    } catch (err) {
      console.error(
        "Session consume subscription lookup DB error:",
        (err as Error).stack
      );
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    // I11: Wrap session creation in try-catch — ticket was already consumed
    let sessionId: string;
    try {
      sessionId = await createPortalSession(redis, {
        userId: user.id,
        avatarUrl: consumedTicket.avatar_url || null,
      });
    } catch (err) {
      console.error("Session creation Redis error:", (err as Error).message);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    await deletePreviousPortalSession(req, redis, config, sessionId);
    setPortalSessionCookie(res, config, sessionId);

    const response = buildPortalSessionResponse(
      user,
      sub?.plan_type ?? "free",
      sub?.status ?? "active",
      consumedTicket.avatar_url || null
    ) as SessionConsumeResponse;

    res.json(response);
  };
}

export function sessionLoginHandler(
  pool: Pool,
  redis: Redis,
  config: AppConfig,
  resolveIdentity: (
    redis: Redis,
    token: string,
    options?: {
      readonly allowedIdTokenAudiences: readonly string[];
      readonly allowUnscopedIdTokens: boolean;
    }
  ) => Promise<GoogleIdentity | null> = resolveGoogleIdentityWithCache,
  upsertUserFn: (pool: Pool, identity: GoogleIdentity) => Promise<UserId> = upsertUser
) {
  return async (req: Request, res: Response) => {
    setSessionNoStoreHeaders(res);
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const token = authHeader.slice(7);
    if (!token) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    let identity: GoogleIdentity | null;
    try {
      identity = await resolveIdentity(redis, token, {
        allowedIdTokenAudiences: config.publicAuth.googleIdTokenAudiences,
        allowUnscopedIdTokens: config.nodeEnv !== "production",
      });
    } catch (err) {
      console.error("Session login token verification error:", (err as Error).message);
      sendError(res, "INVALID_TOKEN");
      return;
    }

    if (!identity) {
      sendError(res, "INVALID_TOKEN");
      return;
    }

    let userId: UserId;
    try {
      userId = await upsertUserFn(pool, identity);
    } catch (err) {
      console.error("Session login user upsert DB error:", (err as Error).stack);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    let sub;
    try {
      sub = await getActiveSubscription(pool, userId);
    } catch (err) {
      console.error(
        "Session login subscription lookup DB error:",
        (err as Error).stack
      );
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    let sessionId: string;
    try {
      sessionId = await createPortalSession(redis, {
        userId,
        avatarUrl: identity.avatar_url,
      });
    } catch (err) {
      console.error("Session login Redis error:", (err as Error).message);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    await deletePreviousPortalSession(req, redis, config, sessionId);
    setPortalSessionCookie(res, config, sessionId);

    const response = buildPortalSessionResponse(
      identity,
      sub?.plan_type ?? "free",
      sub?.status ?? "active",
      identity.avatar_url
    ) as SessionLoginResponse;

    res.json(response);
  };
}

export function sessionMeHandler(pool: Pool) {
  return async (req: Request, res: Response) => {
    setSessionNoStoreHeaders(res);
    if (!req.portalSession) {
      const response: SessionMeResponse = { signed_in: false };
      res.json(response);
      return;
    }

    const user = await findUserById(pool, req.portalSession.userId);
    if (!user) {
      const response: SessionMeResponse = { signed_in: false };
      res.json(response);
      return;
    }

    let sub;
    try {
      sub = await getActiveSubscription(pool, user.id);
    } catch (err) {
      console.error("Session me subscription lookup DB error:", (err as Error).stack);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    const response: SessionMeResponse = {
      signed_in: true,
      user: buildPortalUserSummary(user, req.portalSession.avatarUrl ?? null),
      plan_type: sub?.plan_type ?? "free",
      subscription_status: sub?.status ?? "active",
    };

    res.json(response);
  };
}

export function sessionLogoutHandler(redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    setSessionNoStoreHeaders(res);
    if (req.portalSession) {
      const cookies = parseCookies(req.headers?.cookie);
      const sessionId = cookies[config.session.cookieName];
      if (sessionId) {
        await redis.del(`portal_session:${sessionId}`);
      }
    }

    clearPortalSessionCookie(res, config);
    res.json({ ok: true });
  };
}
