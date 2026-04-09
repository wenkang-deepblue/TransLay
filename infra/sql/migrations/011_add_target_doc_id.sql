-- 011: Persist create_new_file destination document ID
-- Stores only the output file identifier, never document content.

ALTER TABLE translation_jobs
    ADD COLUMN IF NOT EXISTS target_doc_id TEXT;
