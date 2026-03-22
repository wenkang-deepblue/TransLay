-- 007: Create idempotency_records table
-- Prevents duplicate job creation from retries or double-clicks.
-- Records auto-expire; cleanup via periodic DELETE WHERE expires_at < now().

CREATE TABLE idempotency_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key     TEXT NOT NULL,
    job_id              UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    request_fingerprint TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,

    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
);

-- Expiry-aware lookups: index on expires_at for efficient cleanup queries.
-- The UNIQUE constraint on idempotency_key already covers key lookups.
-- Note: partial index with now() is not possible (now() is not IMMUTABLE).
CREATE INDEX idx_idempotency_expires
    ON idempotency_records(expires_at);
