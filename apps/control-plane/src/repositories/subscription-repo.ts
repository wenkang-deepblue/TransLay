import type { Pool, PoolClient } from "pg";
import type { PlanType, SubscriptionStatus, PaymentProviderName, UserId } from "@translay/shared-contracts";

type Queryable = Pool | PoolClient;

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

export interface UpsertSubscriptionInput {
  readonly userId: UserId | string;
  readonly planType: PlanType;
  readonly status: SubscriptionStatus;
  readonly providerName: PaymentProviderName;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string;
  readonly currency: string | null;
  readonly amount: string | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Returns the most relevant subscription for a user:
 * prioritizes active/grace_period pro subscriptions, falls back to free.
 */
export async function getActiveSubscription(
  pool: Queryable,
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

export async function findSubscriptionByProviderId(
  db: Queryable,
  providerName: PaymentProviderName,
  providerSubscriptionId: string
): Promise<SubscriptionRow | null> {
  const result = await db.query(
    `SELECT id, user_id, plan_type, status, provider_name,
            provider_customer_id, provider_subscription_id,
            current_period_start, current_period_end, cancel_at_period_end
     FROM subscriptions
     WHERE provider_name = $1 AND provider_subscription_id = $2
     LIMIT 1`,
    [providerName, providerSubscriptionId]
  );

  return (result.rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function upsertProviderSubscription(
  db: Queryable,
  input: UpsertSubscriptionInput
): Promise<SubscriptionRow> {
  const result = await db.query(
    `INSERT INTO subscriptions (
       user_id, plan_type, status, provider_name, provider_customer_id,
       provider_subscription_id, currency, amount, current_period_start,
       current_period_end, cancel_at_period_end
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (provider_name, provider_subscription_id)
     WHERE provider_subscription_id IS NOT NULL
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       plan_type = EXCLUDED.plan_type,
       status = EXCLUDED.status,
       provider_customer_id = EXCLUDED.provider_customer_id,
       currency = EXCLUDED.currency,
       amount = EXCLUDED.amount,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()
     RETURNING id, user_id, plan_type, status, provider_name,
               provider_customer_id, provider_subscription_id,
               current_period_start, current_period_end, cancel_at_period_end`,
    [
      input.userId,
      input.planType,
      input.status,
      input.providerName,
      input.providerCustomerId,
      input.providerSubscriptionId,
      input.currency,
      input.amount,
      input.currentPeriodStart,
      input.currentPeriodEnd,
      input.cancelAtPeriodEnd,
    ]
  );

  return result.rows[0] as SubscriptionRow;
}
