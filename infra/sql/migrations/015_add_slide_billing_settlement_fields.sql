-- 015: Add provisional/refund slide billing settlement fields
-- Phase 4B.4 requires provisional billing, slide-level refunds, and
-- job-level gross/refund/net aggregates without persisting document content.

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS provisionally_billed_units INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gross_billed_slides INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refunded_slides INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_billed_slides INTEGER NOT NULL DEFAULT 0;

UPDATE translation_jobs
SET
    provisionally_billed_units = total_units_billed,
    gross_billed_slides = total_units_billed,
    refunded_slides = 0,
    net_billed_slides = total_units_billed
WHERE
    provisionally_billed_units = 0
    AND gross_billed_slides = 0
    AND refunded_slides = 0
    AND net_billed_slides = 0
    AND total_units_billed <> 0;

ALTER TABLE usage_ledgers
    ADD COLUMN IF NOT EXISTS slide_index INTEGER,
    ADD COLUMN IF NOT EXISTS ledger_stage TEXT NOT NULL DEFAULT 'finalized',
    ADD COLUMN IF NOT EXISTS related_usage_id UUID REFERENCES usage_ledgers(id) ON DELETE SET NULL;

ALTER TABLE usage_ledgers
    DROP CONSTRAINT IF EXISTS chk_ledgers_quantity_positive;

ALTER TABLE usage_ledgers
    ADD CONSTRAINT chk_ledgers_quantity_nonzero
        CHECK (quantity <> 0);

CREATE INDEX IF NOT EXISTS idx_ledgers_job_slide ON usage_ledgers(job_id, slide_index);
CREATE INDEX IF NOT EXISTS idx_ledgers_related_usage ON usage_ledgers(related_usage_id);
