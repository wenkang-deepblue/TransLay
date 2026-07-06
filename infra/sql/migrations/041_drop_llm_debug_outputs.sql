-- 041: Drop the development-only llm_debug_outputs table

-- The raw LLM output capture path has been removed from the worker. This table
-- only ever stored call metadata; its raw_output_text column was already dropped
-- in migration 022 to enforce zero-content retention. Dropping the table and its
-- indexes completes removal of the debug-capture feature.

DROP TABLE IF EXISTS llm_debug_outputs;
