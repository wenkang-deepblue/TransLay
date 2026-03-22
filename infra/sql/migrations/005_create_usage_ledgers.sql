-- 005: Create usage_ledgers table
-- Append-only quota truth. No mutable remaining_quota field.
-- Entitlement is computed at runtime from SUM(quantity) per billing period.

CREATE TABLE usage_ledgers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    job_id              UUID REFERENCES translation_jobs(id) ON DELETE SET NULL,
    host_type           TEXT NOT NULL,
    usage_unit          TEXT NOT NULL,
    quantity            INTEGER NOT NULL,
    billing_period_key  TEXT NOT NULL,
    reason              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_ledgers_host_type
        CHECK (host_type IN ('docs', 'sheets', 'slides')),
    CONSTRAINT chk_ledgers_usage_unit
        CHECK (usage_unit IN ('pages', 'cells', 'slides')),
    CONSTRAINT chk_ledgers_quantity_positive
        CHECK (quantity > 0)
);

-- Primary query path: "how much has this user consumed in this period for this host?"
CREATE INDEX idx_ledgers_user_period ON usage_ledgers(user_id, host_type, billing_period_key);
