import type { UserSummary } from "../auth/types";
import type { PlanType, SubscriptionStatus } from "../billing/types";

/** POST /api/session/start request body. */
export interface SessionStartRequest {
  readonly redirect_path: string;
  readonly reason: string;
}

/** POST /api/session/start response. */
export interface SessionStartResponse {
  readonly portal_url: string;
  readonly ticket_expires_in_seconds: number;
}

/** POST /api/session/consume request body. */
export interface SessionConsumeRequest {
  readonly ticket: string;
}

/** POST /api/session/consume response. */
export interface SessionConsumeResponse {
  readonly ok: true;
  readonly user: UserSummary;
  readonly plan_type: PlanType;
  readonly subscription_status: SubscriptionStatus;
}

/** POST /api/session/login response. */
export type SessionLoginResponse = SessionConsumeResponse;

/** GET /api/session/me response. */
export type SessionMeResponse =
  | {
      readonly signed_in: true;
      readonly user: UserSummary;
      readonly plan_type: PlanType;
      readonly subscription_status: SubscriptionStatus;
    }
  | {
      readonly signed_in: false;
    };
