-- 037: Add internal super account entitlement plan.

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS chk_subscriptions_plan_type;

ALTER TABLE subscriptions
    ADD CONSTRAINT chk_subscriptions_plan_type
        CHECK (plan_type IN ('free', 'pro_monthly', 'pro_yearly', 'super'));
