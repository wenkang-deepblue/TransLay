-- 019: Development-only LLM debug metadata capture
--
-- IMPORTANT:
-- - This table is for short-lived development / test debugging only.
-- - It must NOT be treated as a permanent product feature.
-- - Production rollout must keep capture disabled by default.
-- - Release hardening must never persist raw model outputs because they can
--   contain user-derived content.

CREATE TABLE IF NOT EXISTS llm_debug_outputs (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    stage TEXT NOT NULL,
    call_label TEXT NOT NULL,
    slide_index INTEGER,
    node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    provider_request_id TEXT,
    capture_status TEXT NOT NULL,
    http_status INTEGER,
    error_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_llm_debug_outputs_node_ids_array
        CHECK (jsonb_typeof(node_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_llm_debug_outputs_job_id_created_at
    ON llm_debug_outputs(job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_debug_outputs_created_at
    ON llm_debug_outputs(created_at DESC);
