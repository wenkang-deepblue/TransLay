-- 016: Persist slide-level execution truth for reconciliation and API exposure
-- Phase 4B.6 requires a durable, queryable source of truth per slide so
-- billing disputes and partial-delivery outcomes can be explained without
-- relying on in-memory worker state or document content persistence.

CREATE TABLE IF NOT EXISTS job_slide_results (
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    slide_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    failure_stage TEXT,
    failure_reason_code TEXT,
    warning_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    provisionally_billed BOOLEAN NOT NULL DEFAULT FALSE,
    final_billable BOOLEAN NOT NULL DEFAULT FALSE,
    refund_required BOOLEAN NOT NULL DEFAULT FALSE,
    refunded BOOLEAN NOT NULL DEFAULT FALSE,
    output_visible BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, slide_index)
);

CREATE INDEX IF NOT EXISTS idx_job_slide_results_job_id
    ON job_slide_results(job_id);

CREATE INDEX IF NOT EXISTS idx_job_slide_results_status
    ON job_slide_results(status);
