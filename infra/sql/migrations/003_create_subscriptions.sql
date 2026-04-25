-- 003: Create subscriptions table
-- Tracks payment and plan state. Allows history (not 1:1 with users).
-- Free users also get an explicit 'free' record to avoid entitlement logic branching.

CREATE TABLE subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    plan_type                   TEXT NOT NULL,
    status                      TEXT NOT NULL,
    provider_name               TEXT NOT NULL,
    provider_customer_id        TEXT,
    provider_subscription_id    TEXT,
    currency                    TEXT,
    amount                      NUMERIC(12,2),
    current_period_start        TIMESTAMPTZ,
    current_period_end          TIMESTAMPTZ,
    cancel_at_period_end        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_subscriptions_plan_type
        CHECK (plan_type IN ('free', 'pro_monthly', 'pro_yearly')),
    CONSTRAINT chk_subscriptions_status
        CHECK (status IN ('active', 'past_due', 'paused', 'canceled', 'expired', 'grace_period', 'blocked'))
);

-- ON DELETE RESTRICT: never silently cascade-delete subscription history

CREATE INDEX idx_subscriptions_user_status ON subscriptions(user_id, status);
CREATE INDEX idx_subscriptions_provider ON subscriptions(provider_name, provider_subscription_id);

CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();
