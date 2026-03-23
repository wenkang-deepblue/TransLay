import type { UserSummary } from "../auth/types";

export const PLAN_TYPES = ["free", "pro_monthly", "pro_yearly"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "canceled",
  "expired",
  "grace_period",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type AccessLevel = "free" | "pro";

/** S6: Supported payment provider names. */
export const PAYMENT_PROVIDER_NAMES = ["none", "paddle"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

/** Metered usage snapshot (free and pro with per-host limits). */
export interface MeteredUsageSnapshot {
  readonly period_key: string;
  readonly slides_used: number;
  readonly slides_limit: number;
  readonly docs_pages_used: number;
  readonly docs_pages_limit: number;
  readonly sheets_cells_used: number;
  readonly sheets_cells_limit: number;
}

/** Usage for plans without per-host limits. */
export interface UnlimitedUsageSnapshot {
  readonly unlimited: true;
}

export type UsageSnapshot = MeteredUsageSnapshot | UnlimitedUsageSnapshot;

/** GET /api/entitlement response. */
export interface EntitlementResponse {
  readonly user: UserSummary;
  readonly access: AccessLevel;
  readonly plan_type: PlanType;
  readonly subscription_status: SubscriptionStatus;
  readonly subscription?: {
    readonly provider_name: string;
    readonly current_period_end: string;
    readonly cancel_at_period_end: boolean;
  };
  readonly usage: UsageSnapshot;
  readonly cache_ttl_seconds: 300;
}

/** POST /api/checkout request body. */
export interface CheckoutRequest {
  readonly plan_type: "pro_monthly" | "pro_yearly";
}

/** POST /api/checkout response. */
export interface CheckoutResponse {
  readonly provider_name: string;
  readonly checkout_url: string;
}

/** GET /api/subscription response. */
export interface SubscriptionDetailResponse {
  readonly plan_type: PlanType;
  readonly subscription_status: SubscriptionStatus;
  readonly provider_name: string;
  readonly current_period_end: string | null;
  readonly cancel_at_period_end: boolean;
  readonly status_message: string | null;
}
