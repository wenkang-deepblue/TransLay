import type { Pool, PoolClient } from "pg";
import type { PaymentProviderName, UserId } from "@translay/shared-contracts";

type Queryable = Pool | PoolClient;

export interface PaymentOrderRow {
  id: string;
  user_id: string;
  provider_name: PaymentProviderName;
  product_type: "subscription" | "credits";
  sku: string;
  amount: string | null;
  currency: string | null;
  provider_checkout_id: string | null;
  provider_transaction_id: string | null;
  provider_subscription_id: string | null;
  status: "pending" | "paid" | "failed" | "refunded" | "partially_refunded";
  created_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
  updated_at: Date;
}

export interface UpsertPaymentOrderInput {
  readonly userId: UserId | string;
  readonly providerName: PaymentProviderName;
  readonly productType: "subscription" | "credits";
  readonly sku: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly providerCheckoutId?: string | null;
  readonly providerTransactionId?: string | null;
  readonly providerSubscriptionId?: string | null;
  readonly status: PaymentOrderRow["status"];
  readonly paidAt?: Date | null;
  readonly refundedAt?: Date | null;
}

export async function upsertPaymentOrder(
  db: Queryable,
  input: UpsertPaymentOrderInput
): Promise<PaymentOrderRow> {
  const result = await db.query(
    `INSERT INTO payment_orders (
       user_id, provider_name, product_type, sku, amount, currency,
       provider_checkout_id, provider_transaction_id, provider_subscription_id,
       status, paid_at, refunded_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (provider_name, provider_transaction_id)
     WHERE provider_transaction_id IS NOT NULL
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       product_type = EXCLUDED.product_type,
       sku = EXCLUDED.sku,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       provider_checkout_id = COALESCE(EXCLUDED.provider_checkout_id, payment_orders.provider_checkout_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, payment_orders.provider_subscription_id),
       status = EXCLUDED.status,
       paid_at = COALESCE(EXCLUDED.paid_at, payment_orders.paid_at),
       refunded_at = COALESCE(EXCLUDED.refunded_at, payment_orders.refunded_at),
       updated_at = NOW()
     RETURNING
       id, user_id, provider_name, product_type, sku, amount, currency,
       provider_checkout_id, provider_transaction_id, provider_subscription_id,
       status, created_at, paid_at, refunded_at, updated_at`,
    [
      input.userId,
      input.providerName,
      input.productType,
      input.sku,
      input.amount,
      input.currency,
      input.providerCheckoutId ?? null,
      input.providerTransactionId ?? null,
      input.providerSubscriptionId ?? null,
      input.status,
      input.paidAt ?? null,
      input.refundedAt ?? null,
    ]
  );

  return result.rows[0] as PaymentOrderRow;
}
