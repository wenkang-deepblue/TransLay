-- 020: add stage orchestration state and persisted layout hints
--
-- Purpose:
-- - persist non-content stage checkpoint / lease metadata so Cloud Tasks retries
--   can resume safely without deadlocking on the coarse translating status
-- - persist accepted layout-semantic hints only (no source/translated text)
--
-- IMPORTANT:
-- - This migration must not store source plaintext or translated plaintext.
-- - stage_payload / stage_cursor are restricted to orchestration metadata only.

ALTER TABLE translation_jobs
  ADD COLUMN IF NOT EXISTS current_stage TEXT,
  ADD COLUMN IF NOT EXISTS stage_status TEXT,
  ADD COLUMN IF NOT EXISTS stage_cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stage_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stage_attempt INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage_last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS queued_task_name TEXT;

UPDATE translation_jobs
SET current_stage = CASE
      WHEN status IN ('pending', 'queued', 'extracting', 'translating', 'writing') THEN 'extract'
      ELSE NULL
    END,
    stage_status = CASE
      WHEN status = 'queued' THEN 'queued'
      WHEN status IN ('extracting', 'translating', 'writing') THEN 'running'
      WHEN status = 'pending' THEN 'pending'
      ELSE NULL
    END,
    stage_cursor = COALESCE(stage_cursor, '{}'::jsonb),
    stage_payload = COALESCE(stage_payload, '{}'::jsonb)
WHERE current_stage IS NULL
   OR stage_status IS NULL
   OR stage_cursor IS NULL
   OR stage_payload IS NULL;

DO $$
BEGIN
  ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_translation_jobs_stage_cursor_object
      CHECK (jsonb_typeof(stage_cursor) = 'object');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_translation_jobs_stage_payload_object
      CHECK (jsonb_typeof(stage_payload) = 'object');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS job_layout_semantic_hints (
  job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  slide_index INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  visual_role TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  line_policy TEXT NOT NULL,
  scale_sync TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_job_layout_semantic_hints_job_slide
  ON job_layout_semantic_hints(job_id, slide_index);
