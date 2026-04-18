-- 026: Persist encrypted host OAuth token metadata for per-user Slides quota
-- isolation, with terminal purging handled by the application layer.

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS host_oauth_access_token_enc BYTEA,
    ADD COLUMN IF NOT EXISTS host_oauth_token_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS host_oauth_source TEXT NOT NULL DEFAULT 'sa_fallback',
    ADD COLUMN IF NOT EXISTS host_oauth_purged_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE translation_jobs
    ADD CONSTRAINT chk_translation_jobs_host_oauth_source
      CHECK (host_oauth_source IN ('addon', 'sa_fallback'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
