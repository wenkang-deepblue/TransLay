-- 034: Track provider-side refund adjustment state for prepaid credit refunds.
-- These fields store billing metadata only; no document content or translation
-- output is persisted.

ALTER TABLE credit_refund_requests
    ADD COLUMN provider_name TEXT,
    ADD COLUMN provider_refund_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN provider_status TEXT,
    ADD COLUMN provider_error TEXT,
    ADD COLUMN amount_refunded NUMERIC(12,2),
    ADD COLUMN currency TEXT;

ALTER TABLE credit_refund_requests
    ADD CONSTRAINT chk_credit_refund_requests_provider_name
        CHECK (provider_name IS NULL OR provider_name IN ('paddle')),
    ADD CONSTRAINT chk_credit_refund_requests_provider_refund_ids_array
        CHECK (jsonb_typeof(provider_refund_ids) = 'array'),
    ADD CONSTRAINT chk_credit_refund_requests_amount_refunded_nonnegative
        CHECK (amount_refunded IS NULL OR amount_refunded >= 0),
    ADD CONSTRAINT chk_credit_refund_requests_provider_error_length
        CHECK (provider_error IS NULL OR char_length(provider_error) <= 1000);
