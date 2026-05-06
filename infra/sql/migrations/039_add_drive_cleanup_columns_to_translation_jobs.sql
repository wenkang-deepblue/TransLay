-- 039: Track temporary Drive worker permission metadata for cleanup.
-- Permission IDs and cleanup state are operational metadata only; no document
-- content, translated text, comments, or notes may be stored here.

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS source_worker_permission_id TEXT,
    ADD COLUMN IF NOT EXISTS target_worker_permission_id TEXT,
    ADD COLUMN IF NOT EXISTS drive_cleanup_status TEXT NOT NULL DEFAULT 'not_required',
    ADD COLUMN IF NOT EXISTS drive_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS drive_cleanup_last_error_code TEXT,
    ADD COLUMN IF NOT EXISTS drive_cleanup_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS drive_cleanup_completed_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_translation_jobs_drive_cleanup_status
      CHECK (drive_cleanup_status IN ('not_required', 'pending', 'succeeded', 'failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_translation_jobs_drive_cleanup_attempts_nonnegative
      CHECK (drive_cleanup_attempts >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_translation_jobs_drive_cleanup_pending
  ON translation_jobs(drive_cleanup_status, started_at)
  WHERE drive_cleanup_status IN ('pending', 'failed');
