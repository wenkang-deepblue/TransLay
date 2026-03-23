-- 010: Add source_language_mode column to translation_jobs (I6 review fix)

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS source_language_mode TEXT NOT NULL DEFAULT 'auto';
