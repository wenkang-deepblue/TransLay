-- 014: Persist structured job warnings and allow completed_with_warnings terminal status
-- Stores metadata only. No source or translated content may be written here.

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE translation_jobs
    DROP CONSTRAINT IF EXISTS chk_jobs_status;

ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_jobs_status
        CHECK (status IN (
            'pending',
            'queued',
            'extracting',
            'translating',
            'writing',
            'completed',
            'completed_with_warnings',
            'failed',
            'canceled'
        ));

DROP INDEX IF EXISTS idx_jobs_completed_equivalent_lookup;

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
WHERE status IN ('completed', 'completed_with_warnings');
