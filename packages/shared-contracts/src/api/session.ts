import type { UserSummary } from "../auth/types";
import type { PlanType, SubscriptionStatus } from "../billing/types";

export type PortalBillingAction =
  | {
      readonly type: "confirm_upgrade_charge";
      readonly amount: number;
      readonly formatted_amount: string;
    }
  | {
      readonly type: "upgrade_charged";
      readonly amount: number;
      readonly formatted_amount: string;
    }
  | {
      readonly type: "redirect";
      readonly url: string;
    }
  | {
      readonly type: "already_canceled";
      readonly period_end: string | null;
    };

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
  readonly subscription?: {
    readonly provider_name: string;
    readonly current_period_start: string;
    readonly current_period_end: string;
    readonly cancel_at_period_end: boolean;
  };
  readonly billing_action?: PortalBillingAction;
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
      readonly subscription?: {
        readonly provider_name: string;
        readonly current_period_start: string;
        readonly current_period_end: string;
        readonly cancel_at_period_end: boolean;
      };
    }
  | {
      readonly signed_in: false;
    };
