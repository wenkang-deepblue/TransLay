-- 027: Backfill slide billing component fields without relying on output visibility.
-- 018 only migrated rows that were already output-visible, which can miss
-- provisionally billed or refunded rows that were never surfaced to users.

UPDATE job_slide_results
SET
    provisional_billed_units = CASE
        WHEN provisionally_billed THEN GREATEST(provisional_billed_units, 1.0)
        ELSE 0
    END,
    final_billed_units = CASE
        WHEN final_billable THEN GREATEST(final_billed_units, 1.0)
        ELSE 0
    END,
    refunded_units = CASE
        WHEN refunded THEN GREATEST(refunded_units, 1.0)
        ELSE 0
    END,
    content_output_visible = CASE
        WHEN output_visible THEN TRUE
        ELSE content_output_visible
    END
WHERE
    (provisionally_billed AND provisional_billed_units = 0)
    OR (final_billable AND final_billed_units = 0)
    OR (refunded AND refunded_units = 0)
    OR (output_visible AND content_output_visible = FALSE);
