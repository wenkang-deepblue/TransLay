-- 022: Remove raw LLM output persistence to enforce zero-content retention

ALTER TABLE llm_debug_outputs
    DROP COLUMN IF EXISTS raw_output_text;
