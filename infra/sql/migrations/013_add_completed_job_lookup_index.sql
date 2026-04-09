-- 013: Speed up completed-job replay checks used by resubmit gating
-- Matches the normalized lookup performed by hasCompletedEquivalentJob().

CREATE INDEX IF NOT EXISTS idx_jobs_completed_equivalent_lookup
ON translation_jobs (
    user_id,
    host_type,
    source_doc_id,
    lower(target_language_input),
    output_mode,
    range_mode,
    COALESCE(range_expression, '')
)
WHERE status = 'completed';
