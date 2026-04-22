-- 029: Stop persisting source document titles in translation_jobs
-- Keep request compatibility for Add-on UI while removing long-term title retention.

ALTER TABLE translation_jobs
    ALTER COLUMN source_doc_name DROP NOT NULL;

UPDATE translation_jobs
   SET source_doc_name = NULL
 WHERE source_doc_name IS NOT NULL;
