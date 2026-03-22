import type {
  PlanType,
  SubscriptionStatus,
  AccessLevel,
} from "@translay/shared-contracts";

export interface EntitlementInput {
  readonly plan_type: PlanType;
  readonly subscription_status: SubscriptionStatus;
  readonly cancel_at_period_end: boolean;
  readonly current_period_end: Date | null;
}

export interface EntitlementResult {
  readonly access: AccessLevel;
  readonly active: boolean;
  /** i18n message key when cancel_at_period_end is true, null otherwise. */
  readonly cancellation_notice: CancellationNotice | null;
}

export interface CancellationNotice {
  readonly key: "subscription_canceled_notice";
  readonly period_end_iso: string;
}

/** Compute entitlement from subscription state. Truth lives in PostgreSQL. */
export function computeEntitlement(input: EntitlementInput): EntitlementResult {
  const { plan_type, subscription_status, cancel_at_period_end, current_period_end } = input;

  if (plan_type === "free") {
    return { access: "free", active: true, cancellation_notice: null };
  }

  let isPro: boolean;
  switch (subscription_status) {
    case "active":
    case "grace_period":
      isPro = true;
      break;
    case "past_due":
    case "canceled":
    case "expired":
      isPro = false;
      break;
    default: {
      const _exhaustive: never = subscription_status;
      throw new Error(`Unknown subscription status: ${_exhaustive}`);
    }
  }

  let cancellation_notice: CancellationNotice | null = null;
  if (cancel_at_period_end && current_period_end) {
    cancellation_notice = {
      key: "subscription_canceled_notice",
      period_end_iso: current_period_end.toISOString(),
    };
  }

  return {
    access: isPro ? "pro" : "free",
    active: isPro,
    cancellation_notice,
  };
}
