-- 038: Scope job idempotency records by user.
-- The same document-level request can be submitted by different editors.
-- Idempotency must only deduplicate retries from the same authenticated user.

ALTER TABLE idempotency_records
    DROP CONSTRAINT IF EXISTS uq_idempotency_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'idempotency_records'::regclass
          AND conname = 'uq_idempotency_user_key'
    ) THEN
        ALTER TABLE idempotency_records
            ADD CONSTRAINT uq_idempotency_user_key UNIQUE (user_id, idempotency_key);
    END IF;
END $$;
