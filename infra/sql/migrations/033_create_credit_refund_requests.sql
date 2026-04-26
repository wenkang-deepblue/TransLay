-- 033: Create prepaid credit refund request truth tables.
-- Refund requests reserve unused credit grant units before provider-side review.

CREATE TABLE credit_refund_requests (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    unit                        TEXT NOT NULL,
    requested_units             NUMERIC(12,1) NOT NULL,
    status                      TEXT NOT NULL DEFAULT 'submitted',
    reason                      TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at                 TIMESTAMPTZ,
    completed_at                TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_credit_refund_requests_unit
        CHECK (unit IN ('slides_pages', 'docs_pages', 'sheets_cells')),
    CONSTRAINT chk_credit_refund_requests_units
        CHECK (requested_units > 0),
    CONSTRAINT chk_credit_refund_requests_status
        CHECK (status IN ('submitted', 'approved', 'rejected', 'completed', 'canceled')),
    CONSTRAINT chk_credit_refund_requests_reason_length
        CHECK (reason IS NULL OR char_length(reason) <= 500)
);

CREATE TRIGGER trg_credit_refund_requests_updated_at
    BEFORE UPDATE ON credit_refund_requests
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE credit_refund_request_items (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_request_id           UUID NOT NULL REFERENCES credit_refund_requests(id) ON DELETE RESTRICT,
    credit_grant_id             UUID NOT NULL REFERENCES credit_grants(id) ON DELETE RESTRICT,
    order_id                    UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
    units                       NUMERIC(12,1) NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_credit_refund_request_items_units
        CHECK (units > 0)
);

CREATE INDEX idx_credit_refund_requests_user_status
    ON credit_refund_requests(user_id, unit, status, created_at DESC);

CREATE INDEX idx_credit_refund_request_items_grant
    ON credit_refund_request_items(credit_grant_id);

CREATE INDEX idx_credit_refund_request_items_request
    ON credit_refund_request_items(refund_request_id);
