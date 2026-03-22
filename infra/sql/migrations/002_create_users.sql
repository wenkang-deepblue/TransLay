-- 002: Create users table
-- Stores minimal identity metadata only. No document content.
-- google_subject_id is the identity truth, not email.

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_subject_id TEXT NOT NULL,
    email           TEXT,
    email_hash      TEXT,
    display_name    TEXT,
    default_locale  TEXT NOT NULL DEFAULT 'en',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ,

    CONSTRAINT uq_users_google_subject_id UNIQUE (google_subject_id)
);

-- Enforce immutability: google_subject_id must never change after insert
CREATE OR REPLACE FUNCTION fn_users_immutable_subject_id()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.google_subject_id IS DISTINCT FROM NEW.google_subject_id THEN
        RAISE EXCEPTION 'google_subject_id is immutable once set';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_immutable_subject_id
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION fn_users_immutable_subject_id();

-- Auto-update updated_at on modification
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();
