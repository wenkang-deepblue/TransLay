-- 006: Create job_segments table
-- Optional metadata tracking for chunked long jobs. No segment text content.

CREATE TABLE job_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    segment_index   INTEGER NOT NULL,
    segment_type    TEXT NOT NULL,
    provider_name   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    error_code      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_segments_type
        CHECK (segment_type IN ('extract', 'translate', 'write')),
    CONSTRAINT chk_segments_status
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT uq_segments_job_index UNIQUE (job_id, segment_index)
);

CREATE INDEX idx_segments_job ON job_segments(job_id, segment_index);

CREATE TRIGGER trg_segments_updated_at
    BEFORE UPDATE ON job_segments
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();
