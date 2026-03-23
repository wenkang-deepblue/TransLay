import type { Pool } from "pg";
import type { PlanType, SubscriptionStatus, PaymentProviderName, UserId } from "@translay/shared-contracts";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_type: PlanType;
  status: SubscriptionStatus;
  provider_name: PaymentProviderName;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
}

/**
 * Returns the most relevant subscription for a user:
 * prioritizes active/grace_period pro subscriptions, falls back to free.
 */
export async function getActiveSubscription(
  pool: Pool,
  userId: UserId
): Promise<SubscriptionRow | null> {
  const result = await pool.query(
    `SELECT id, user_id, plan_type, status, provider_name,
            provider_customer_id, provider_subscription_id,
            current_period_start, current_period_end, cancel_at_period_end
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY
       CASE WHEN status IN ('active', 'grace_period') THEN 0 ELSE 1 END,
       CASE WHEN plan_type != 'free' THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}
