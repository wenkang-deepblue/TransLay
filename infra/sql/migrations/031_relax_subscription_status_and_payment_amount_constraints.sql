-- 031: Align billing status and amount constraints with Paddle Phase 3 behavior.

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS chk_subscriptions_status;

ALTER TABLE subscriptions
    ADD CONSTRAINT chk_subscriptions_status
        CHECK (status IN ('active', 'past_due', 'paused', 'canceled', 'expired', 'grace_period', 'blocked'));

ALTER TABLE payment_orders
    DROP CONSTRAINT IF EXISTS chk_payment_orders_amount_nonnegative;

ALTER TABLE payment_orders
    ADD CONSTRAINT chk_payment_orders_amount_nonnegative
        CHECK (amount IS NULL OR amount >= 0);

COMMENT ON COLUMN payment_orders.amount IS
    'Payment amount in major currency units, not provider minor units.';
