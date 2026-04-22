import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  GoogleIdentity,
  UserId,
  GoogleSubjectId,
} from "@translay/shared-contracts";
import { upsertUser } from "../repositories/user-repo";
import { sendError } from "../utils/errors";

// Augmentations consolidated in types/express.d.ts

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const IDENTITY_CACHE_TTL = 90; // seconds
const idTokenClient = new OAuth2Client();

interface IdentityResolutionOptions {
  readonly allowedIdTokenAudiences: readonly string[];
  readonly allowUnscopedIdTokens: boolean;
}

function isLikelyJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

async function fetchAsAccessToken(token: string): Promise<GoogleIdentity | null> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  const sub = data.sub as string | undefined;
  if (!sub) return null;
  return {
    google_subject_id: sub as GoogleSubjectId,
    email: (data.email as string) ?? null,
    display_name: (data.name as string) ?? null,
    avatar_url: (data.picture as string) ?? null,
  };
}

async function fetchAsIdToken(
  token: string,
  options: IdentityResolutionOptions
): Promise<GoogleIdentity | null> {
  if (
    options.allowedIdTokenAudiences.length === 0 &&
    !options.allowUnscopedIdTokens
  ) {
    return null;
  }

  const ticket = await idTokenClient.verifyIdToken({
    idToken: token,
    audience:
      options.allowedIdTokenAudiences.length > 0
        ? [...options.allowedIdTokenAudiences]
        : undefined,
  });
  const data = ticket.getPayload();
  if (!data) return null;
  const sub = data.sub as string | undefined;
  if (!sub) return null;
  return {
    google_subject_id: sub as GoogleSubjectId,
    email: (data.email as string) ?? null,
    display_name: (data.name as string) ?? null,
    avatar_url: (data.picture as string) ?? null,
  };
}

/**
 * Resolves Google identity from token, trying Access Token first then ID Token.
 * Network errors on the first attempt do NOT prevent the ID Token fallback (I8).
 */
async function resolveGoogleIdentity(
  token: string,
  options: IdentityResolutionOptions
): Promise<GoogleIdentity | null> {
  if (isLikelyJwt(token)) {
    try {
      return await fetchAsIdToken(token, options);
    } catch (err) {
      console.error("Google ID Token verification failed:", (err as Error).message);
      return null;
    }
  }

  let identity: GoogleIdentity | null = null;

  try {
    identity = await fetchAsAccessToken(token);
  } catch (err) {
    // C4: Log network errors at warn — fall through to ID token path
    console.warn("Google Access Token verification failed:", (err as Error).message);
  }

  if (identity) return identity;

  try {
    identity = await fetchAsIdToken(token, options);
  } catch (err) {
    // C4: Both verification paths failed — log at error level
    console.error("Google ID Token verification also failed:", (err as Error).message);
  }

  return identity;
}

/**
 * S1: Check Redis cache before calling Google APIs. Cache valid identities briefly
 * to reduce latency on repeated requests within the same session.
 */
export async function resolveGoogleIdentityWithCache(
  redis: Redis,
  token: string,
  options: IdentityResolutionOptions = {
    allowedIdTokenAudiences: [],
    allowUnscopedIdTokens: true,
  }
): Promise<GoogleIdentity | null> {
  // C1: Hash full token to prevent cache key collision / spoofing
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const cacheKey = `auth_token:${tokenHash}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as GoogleIdentity;
    }
  } catch (err) {
    // C5: Log Redis read failure — proceed to Google but keep it observable
    console.warn("Auth cache read error:", (err as Error).message);
  }

  const identity = await resolveGoogleIdentity(token, options);

  if (identity) {
    try {
      await redis.set(cacheKey, JSON.stringify(identity), "EX", IDENTITY_CACHE_TTL);
    } catch (err) {
      // C5: Cache write failure is non-critical but must be observable
      console.warn("Auth cache write error:", (err as Error).message);
    }
  }

  return identity;
}

/**
 * Express middleware: validates Google token, upserts user, attaches AuthContext.
 * C3: Distinguishes auth failures (401) from infrastructure failures (503).
 */
export function googleAuthMiddleware(
  pool: Pool,
  redis: Redis,
  config: Pick<AppConfig, "publicAuth" | "nodeEnv">
) {
  return async (req: Request, res: Response, next: NextFunction) => {
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
      identity = await resolveGoogleIdentityWithCache(redis, token, {
        allowedIdTokenAudiences: config.publicAuth.googleIdTokenAudiences,
        allowUnscopedIdTokens: config.nodeEnv !== "production",
      });
    } catch (err) {
      console.error("Google token verification error:", (err as Error).message);
      sendError(res, "INVALID_TOKEN");
      return;
    }

    if (!identity) {
      sendError(res, "INVALID_TOKEN");
      return;
    }

    // C3: DB errors are infrastructure failures, not auth failures
    let userId: string;
    try {
      userId = await upsertUser(pool, identity);
    } catch (err) {
      console.error("User upsert DB error:", (err as Error).stack);
      res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Service temporarily unavailable",
      });
      return;
    }

    req.authContext = {
      identity,
      user_id: userId as UserId,
    };

    next();
  };
}
