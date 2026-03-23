import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  SessionStartResponse,
  SessionConsumeResponse,
  SessionMeResponse,
} from "@translay/shared-contracts";
import { findUserById } from "../../repositories/user-repo";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { sendError } from "../../utils/errors";
import { parseCookies } from "../../utils/cookies";
import { assertMultiOk } from "../../utils/redis-helpers";

const TICKET_TTL = 60;
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

function generateSecureId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * C1: Lua script for atomic ticket consumption.
 * C3: Returns user_id directly to avoid TOCTOU with separate HGET after EXPIRE.
 * Returns: user_id string = consumed successfully, "0" = already consumed, "-1" = ticket not found
 */
const CONSUME_TICKET_LUA = `
local key = KEYS[1]
local exists = redis.call('EXISTS', key)
if exists == 0 then return "-1" end
local consumed = redis.call('HGET', key, 'consumed')
if consumed == '1' then return "0" end
local user_id = redis.call('HGET', key, 'user_id')
redis.call('HSET', key, 'consumed', '1')
redis.call('EXPIRE', key, 5)
return user_id or "-1"
`;

export function sessionStartHandler(redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
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

    const results = await redis
      .multi()
      .hset(ticketKey, {
        user_id: auth.user_id,
        redirect_path: path,
        reason: ticketReason,
        consumed: "0",
      })
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
        error: "JOB_INTERNAL_ERROR",
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

    const userId = consumeResult;

    const user = await findUserById(pool, userId);
    if (!user) {
      sendError(res, "INVALID_TICKET");
      return;
    }

    const sub = await getActiveSubscription(pool, user.id);

    const sessionId = generateSecureId();
    const sessionKey = `portal_session:${sessionId}`;

    // I11: Wrap session creation in try-catch — ticket was already consumed
    let results: Array<[Error | null, unknown]> | null;
    try {
      results = await redis
        .multi()
        .hset(sessionKey, {
          user_id: user.id,
          created_at: new Date().toISOString(),
        })
        .expire(sessionKey, SESSION_TTL)
        .exec();
      assertMultiOk(results, "session/consume session create");
    } catch (err) {
      console.error("Session creation Redis error:", (err as Error).message);
      res.status(503).json({
        error: "JOB_INTERNAL_ERROR",
        message: "Service temporarily unavailable",
      });
      return;
    }

    const cookieValue = `${config.session.cookieName}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
    res.setHeader("Set-Cookie", cookieValue);

    const response: SessionConsumeResponse = {
      ok: true,
      user: {
        google_subject_id: user.google_subject_id,
        email: user.email,
        display_name: user.display_name,
      },
      plan_type: sub?.plan_type ?? "free",
      subscription_status: sub?.status ?? "active",
    };

    res.json(response);
  };
}

export function sessionMeHandler(pool: Pool) {
  return async (req: Request, res: Response) => {
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

    const sub = await getActiveSubscription(pool, user.id);

    const response: SessionMeResponse = {
      signed_in: true,
      user: {
        google_subject_id: user.google_subject_id,
        email: user.email,
        display_name: user.display_name,
      },
      plan_type: sub?.plan_type ?? "free",
      subscription_status: sub?.status ?? "active",
    };

    res.json(response);
  };
}

export function sessionLogoutHandler(redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    if (req.portalSession) {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies[config.session.cookieName];
      if (sessionId) {
        await redis.del(`portal_session:${sessionId}`);
      }
    }

    const clearCookie = `${config.session.cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
    res.setHeader("Set-Cookie", clearCookie);
    res.json({ ok: true });
  };
}
