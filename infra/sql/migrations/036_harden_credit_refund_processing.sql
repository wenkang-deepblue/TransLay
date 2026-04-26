-- 036: Harden credit refund processing idempotency and queue lookups.
-- This migration is safe to run after the Phase 4 credit tables already exist.

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_refund_request_items_request_grant
    ON credit_refund_request_items(refund_request_id, credit_grant_id);

CREATE INDEX IF NOT EXISTS idx_credit_refund_requests_provider_pending
    ON credit_refund_requests(provider_name, provider_status, reviewed_at, created_at, id)
    WHERE status = 'submitted'
      AND provider_name = 'paddle'
      AND provider_status IN ('pending', 'pending_approval');

CREATE INDEX IF NOT EXISTS idx_credit_refund_requests_provider_queue
    ON credit_refund_requests(provider_name, provider_status, created_at, id)
    WHERE status = 'submitted';

ALTER TABLE payment_orders
    DROP CONSTRAINT IF EXISTS chk_payment_orders_provider_name;

ALTER TABLE payment_orders
    ADD CONSTRAINT chk_payment_orders_provider_name
        CHECK (provider_name ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;

ALTER TABLE credit_grants
    DROP CONSTRAINT IF EXISTS chk_credit_grants_provider_name;

ALTER TABLE credit_grants
    ADD CONSTRAINT chk_credit_grants_provider_name
        CHECK (provider_name ~ '^[a-z][a-z0-9_]{1,63}$') NOT VALID;

ALTER TABLE credit_refund_requests
    DROP CONSTRAINT IF EXISTS chk_credit_refund_requests_provider_name;

ALTER TABLE credit_refund_requests
    ADD CONSTRAINT chk_credit_refund_requests_provider_name
        CHECK (
            provider_name IS NULL
            OR provider_name ~ '^[a-z][a-z0-9_]{1,63}$'
        ) NOT VALID;

ALTER TABLE payment_orders
    VALIDATE CONSTRAINT chk_payment_orders_provider_name;

ALTER TABLE credit_grants
    VALIDATE CONSTRAINT chk_credit_grants_provider_name;

ALTER TABLE credit_refund_requests
    VALIDATE CONSTRAINT chk_credit_refund_requests_provider_name;
