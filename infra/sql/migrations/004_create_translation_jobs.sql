-- 004: Create translation_jobs table
-- Records job lifecycle metadata only. No document content or translated text.

CREATE TABLE translation_jobs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    host_type               TEXT NOT NULL,
    source_doc_id           TEXT NOT NULL,
    source_doc_name         TEXT NOT NULL,
    source_language         TEXT,
    target_language_input   TEXT NOT NULL,
    target_language_code    TEXT,
    output_mode             TEXT NOT NULL,
    range_mode              TEXT NOT NULL,
    range_expression        TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending',
    provider_route          JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_units_billed      INTEGER NOT NULL DEFAULT 0,
    output_document_url     TEXT,
    error_code              TEXT,
    error_message           TEXT,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,

    CONSTRAINT chk_jobs_host_type
        CHECK (host_type IN ('docs', 'sheets', 'slides')),
    CONSTRAINT chk_jobs_output_mode
        CHECK (output_mode IN ('append_in_file', 'create_new_file')),
    CONSTRAINT chk_jobs_range_mode
        CHECK (range_mode IN ('current', 'entire', 'custom')),
    CONSTRAINT chk_jobs_status
        CHECK (status IN (
            'pending', 'queued', 'extracting', 'translating',
            'writing', 'completed', 'failed', 'canceled'
        ))
);

CREATE INDEX idx_jobs_user_status ON translation_jobs(user_id, status, started_at DESC);
CREATE INDEX idx_jobs_source_doc ON translation_jobs(source_doc_id, user_id, started_at DESC);
