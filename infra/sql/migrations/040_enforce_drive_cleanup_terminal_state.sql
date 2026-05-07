-- 040: Prevent Drive cleanup terminal state regression.
-- Cleanup status is operational metadata only; this migration stores no
-- document body, translation output, comments, or notes.

CREATE OR REPLACE FUNCTION prevent_drive_cleanup_terminal_regression()
RETURNS trigger AS $$
BEGIN
  IF OLD.drive_cleanup_status IN ('not_required', 'succeeded')
     AND NEW.drive_cleanup_status IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'drive_cleanup_status cannot regress from % to %',
      OLD.drive_cleanup_status,
      NEW.drive_cleanup_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_drive_cleanup_terminal_regression ON translation_jobs;

CREATE TRIGGER trg_prevent_drive_cleanup_terminal_regression
BEFORE UPDATE OF drive_cleanup_status ON translation_jobs
FOR EACH ROW
EXECUTE FUNCTION prevent_drive_cleanup_terminal_regression();
