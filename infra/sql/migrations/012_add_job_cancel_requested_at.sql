-- 012: Persist cancel requests on translation_jobs
-- Allows control-plane initiated cancellation to survive worker retries/restarts.

ALTER TABLE translation_jobs
ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
