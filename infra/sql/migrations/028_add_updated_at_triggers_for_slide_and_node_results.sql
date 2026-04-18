-- 028: Keep slide/node execution truth updated_at fields honest.

DO $$
BEGIN
  CREATE TRIGGER trg_job_slide_results_updated_at
    BEFORE UPDATE ON job_slide_results
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TRIGGER trg_job_node_results_updated_at
    BEFORE UPDATE ON job_node_results
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
