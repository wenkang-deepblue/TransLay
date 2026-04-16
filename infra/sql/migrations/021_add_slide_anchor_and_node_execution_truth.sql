-- 021: Persist stable slide anchors and node-level execution truth

ALTER TABLE job_slide_results
    ADD COLUMN IF NOT EXISTS source_slide_object_id TEXT,
    ADD COLUMN IF NOT EXISTS source_slide_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS output_slide_object_id TEXT,
    ADD COLUMN IF NOT EXISTS body_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notes_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS body_translated_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notes_translated_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS body_failed_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notes_failed_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS body_written_node_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notes_written_node_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS job_node_results (
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    slide_index INTEGER NOT NULL CHECK (slide_index >= 0),
    source_slide_object_id TEXT NOT NULL,
    source_slide_fingerprint TEXT,
    node_kind TEXT NOT NULL CHECK (node_kind IN ('body', 'notes')),
    translation_status TEXT NOT NULL CHECK (translation_status IN ('pending', 'succeeded', 'failed', 'skipped')),
    materialization_status TEXT NOT NULL CHECK (materialization_status IN ('pending', 'succeeded', 'failed', 'skipped')),
    write_status TEXT NOT NULL CHECK (write_status IN ('pending', 'succeeded', 'failed', 'skipped')),
    output_visible BOOLEAN NOT NULL DEFAULT FALSE,
    failure_reason_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_job_node_results_job_slide
    ON job_node_results(job_id, slide_index);
