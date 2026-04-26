-- 032: Create prepaid usage credit truth tables.
-- Credits are prepaid assets and stay separate from usage_ledgers so purchases,
-- consumption, refunds, and manual adjustments remain auditable per order.

CREATE TABLE credit_balances (
    user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    slides_balance              NUMERIC(12,1) NOT NULL DEFAULT 0,
    docs_pages_balance          NUMERIC(12,1) NOT NULL DEFAULT 0,
    sheets_cells_balance        NUMERIC(12,1) NOT NULL DEFAULT 0,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_credit_balances_nonnegative
        CHECK (
            slides_balance >= 0
            AND docs_pages_balance >= 0
            AND sheets_cells_balance >= 0
        )
);

CREATE TRIGGER trg_credit_balances_updated_at
    BEFORE UPDATE ON credit_balances
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE credit_grants (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_id                    UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
    provider_name               TEXT NOT NULL,
    provider_transaction_id     TEXT NOT NULL,
    source                      TEXT NOT NULL,
    unit                        TEXT NOT NULL,
    purchased_units             NUMERIC(12,1) NOT NULL,
    used_units                  NUMERIC(12,1) NOT NULL DEFAULT 0,
    refunded_units              NUMERIC(12,1) NOT NULL DEFAULT 0,
    currency                    TEXT,
    amount_paid                 NUMERIC(12,2),
    expires_at                  TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_credit_grants_provider_name
        CHECK (provider_name IN ('paddle')),
    CONSTRAINT chk_credit_grants_source
        CHECK (source IN ('pay_as_you_go', 'subscription_extra')),
    CONSTRAINT chk_credit_grants_unit
        CHECK (unit IN ('slides_pages', 'docs_pages', 'sheets_cells')),
    CONSTRAINT chk_credit_grants_units
        CHECK (
            purchased_units > 0
            AND used_units >= 0
            AND refunded_units >= 0
            AND used_units + refunded_units <= purchased_units
        ),
    CONSTRAINT chk_credit_grants_amount_nonnegative
        CHECK (amount_paid IS NULL OR amount_paid >= 0)
);

COMMENT ON TABLE credit_grants IS
    'Per-order prepaid credit grants. refundable_units = purchased_units - used_units - refunded_units.';

CREATE UNIQUE INDEX idx_credit_grants_provider_transaction_unique
    ON credit_grants(provider_name, provider_transaction_id);

CREATE INDEX idx_credit_grants_user_refundable
    ON credit_grants(user_id, unit, created_at, id)
    WHERE purchased_units > used_units + refunded_units;

CREATE TRIGGER trg_credit_grants_updated_at
    BEFORE UPDATE ON credit_grants
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE credit_ledger (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_id                    UUID REFERENCES payment_orders(id) ON DELETE RESTRICT,
    credit_grant_id             UUID REFERENCES credit_grants(id) ON DELETE RESTRICT,
    job_id                      UUID REFERENCES translation_jobs(id) ON DELETE SET NULL,
    unit                        TEXT NOT NULL,
    delta                       NUMERIC(12,1) NOT NULL,
    balance_after               NUMERIC(12,1) NOT NULL,
    reason                      TEXT NOT NULL,
    idempotency_key             TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_credit_ledger_unit
        CHECK (unit IN ('slides_pages', 'docs_pages', 'sheets_cells')),
    CONSTRAINT chk_credit_ledger_delta_nonzero
        CHECK (delta <> 0),
    CONSTRAINT chk_credit_ledger_balance_after_nonnegative
        CHECK (balance_after >= 0),
    CONSTRAINT chk_credit_ledger_reason
        CHECK (reason IN ('purchase', 'consume', 'refund', 'manual_adjustment'))
);

CREATE UNIQUE INDEX idx_credit_ledger_user_idempotency_unique
    ON credit_ledger(user_id, idempotency_key);

CREATE INDEX idx_credit_ledger_user_created_at
    ON credit_ledger(user_id, created_at DESC);

CREATE INDEX idx_credit_ledger_job
    ON credit_ledger(job_id)
    WHERE job_id IS NOT NULL;
