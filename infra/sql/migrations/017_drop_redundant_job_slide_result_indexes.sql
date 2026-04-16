-- 017: Drop redundant job_slide_results indexes introduced in 016
-- The PRIMARY KEY (job_id, slide_index) already covers lookups by job_id.
-- No current query pattern benefits from a standalone status index.

DROP INDEX IF EXISTS idx_job_slide_results_job_id;
DROP INDEX IF EXISTS idx_job_slide_results_status;
