-- 030: Create payment_orders and enforce billing idempotency keys.
-- Phase 3 landing/billing flow needs durable order records plus provider-level
-- unique identifiers for webhook deduplication and subscription upserts.
-- Migration 002 normally creates this helper; the guard keeps this migration
-- self-contained for isolated billing test databases.

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE payment_orders (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider_name               TEXT NOT NULL,
    product_type                TEXT NOT NULL,
    sku                         TEXT NOT NULL,
    amount                      NUMERIC(12,2),
    currency                    TEXT,
    provider_checkout_id        TEXT,
    provider_transaction_id     TEXT,
    provider_subscription_id    TEXT,
    status                      TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                     TIMESTAMPTZ,
    refunded_at                 TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_payment_orders_provider_name
        CHECK (provider_name IN ('paddle')),
    CONSTRAINT chk_payment_orders_product_type
        CHECK (product_type IN ('subscription', 'credits')),
    CONSTRAINT chk_payment_orders_status
        CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
    CONSTRAINT chk_payment_orders_amount_nonnegative
        CHECK (amount IS NULL OR amount >= 0)
);

COMMENT ON COLUMN payment_orders.amount IS
    'Payment amount in major currency units, not provider minor units.';

CREATE INDEX idx_payment_orders_user_created_at
    ON payment_orders(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_payment_orders_provider_transaction_unique
    ON payment_orders(provider_name, provider_transaction_id)
    WHERE provider_transaction_id IS NOT NULL;

CREATE TRIGGER trg_payment_orders_updated_at
    BEFORE UPDATE ON payment_orders
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();

CREATE UNIQUE INDEX idx_webhook_events_provider_event_unique
    ON webhook_events(provider_name, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX idx_subscriptions_provider_subscription_unique
    ON subscriptions(provider_name, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;
