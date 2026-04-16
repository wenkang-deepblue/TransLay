-- 018: Enable half-slide billing precision and notes component tracking
-- Notes/content partial delivery must support 0.5 slide billing while keeping
-- durable per-slide reconciliation metadata for the control-plane.

ALTER TABLE translation_jobs
    ALTER COLUMN total_units_billed TYPE NUMERIC(12,1) USING total_units_billed::numeric(12,1),
    ALTER COLUMN provisionally_billed_units TYPE NUMERIC(12,1) USING provisionally_billed_units::numeric(12,1),
    ALTER COLUMN gross_billed_slides TYPE NUMERIC(12,1) USING gross_billed_slides::numeric(12,1),
    ALTER COLUMN refunded_slides TYPE NUMERIC(12,1) USING refunded_slides::numeric(12,1),
    ALTER COLUMN net_billed_slides TYPE NUMERIC(12,1) USING net_billed_slides::numeric(12,1);

ALTER TABLE usage_ledgers
    ALTER COLUMN quantity TYPE NUMERIC(12,1) USING quantity::numeric(12,1);

ALTER TABLE job_slide_results
    ADD COLUMN IF NOT EXISTS notes_present BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS content_translated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notes_translated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS content_output_visible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notes_output_visible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notes_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS provisional_billed_units NUMERIC(12,1) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS final_billed_units NUMERIC(12,1) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refunded_units NUMERIC(12,1) NOT NULL DEFAULT 0;

UPDATE job_slide_results
SET
    provisional_billed_units = CASE WHEN provisionally_billed THEN 1 ELSE 0 END,
    final_billed_units = CASE WHEN final_billable THEN 1 ELSE 0 END,
    refunded_units = CASE WHEN refunded THEN 1 ELSE 0 END,
    content_output_visible = output_visible
WHERE
    provisional_billed_units = 0
    AND final_billed_units = 0
    AND refunded_units = 0
    AND content_output_visible = FALSE
    AND output_visible = TRUE;
