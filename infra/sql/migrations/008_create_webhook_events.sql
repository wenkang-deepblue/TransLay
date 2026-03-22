-- 008: Create webhook_events table
-- Stores all payment webhook raw payloads for audit and replay.
-- payload_json only contains payment data, never document content.

CREATE TABLE webhook_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name       TEXT NOT NULL,
    provider_event_id   TEXT,
    event_type          TEXT NOT NULL,
    payload_json        JSONB NOT NULL,
    signature_valid     BOOLEAN NOT NULL,
    processed           BOOLEAN NOT NULL DEFAULT FALSE,
    processing_error    TEXT,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ,

    -- Reject events with invalid signatures at the DB level as a defense-in-depth measure.
    -- Application layer must also reject before insert, but this constraint
    -- ensures no invalid-signature event can persist even if app logic is bypassed.
    CONSTRAINT chk_webhook_signature_valid CHECK (signature_valid = TRUE)
);

CREATE INDEX idx_webhook_provider_event
    ON webhook_events(provider_name, provider_event_id);
CREATE INDEX idx_webhook_unprocessed
    ON webhook_events(processed, received_at)
    WHERE processed = FALSE;
