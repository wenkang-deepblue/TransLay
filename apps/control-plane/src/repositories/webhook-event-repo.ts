import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export interface WebhookEventRow {
  id: string;
  provider_name: string;
  provider_event_id: string | null;
  event_type: string;
  signature_valid: boolean;
  processed: boolean;
  processing_error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

export interface WebhookEventInsertResult {
  readonly row: WebhookEventRow;
  readonly inserted: boolean;
}

export async function findWebhookEventByProviderId(
  db: Queryable,
  providerName: string,
  providerEventId: string
): Promise<WebhookEventRow | null> {
  const result = await db.query(
    `SELECT id, provider_name, provider_event_id, event_type, signature_valid,
            processed, processing_error, received_at, processed_at
     FROM webhook_events
     WHERE provider_name = $1 AND provider_event_id = $2
     LIMIT 1`,
    [providerName, providerEventId]
  );

  return (result.rows[0] as WebhookEventRow | undefined) ?? null;
}

export async function lockWebhookEventForProcessing(
  db: Queryable,
  webhookEventId: string
): Promise<WebhookEventRow> {
  const result = await db.query(
    `SELECT id, provider_name, provider_event_id, event_type, signature_valid,
            processed, processing_error, received_at, processed_at
     FROM webhook_events
     WHERE id = $1
     FOR UPDATE`,
    [webhookEventId]
  );

  const row = result.rows[0] as WebhookEventRow | undefined;
  if (!row) {
    throw new Error("Webhook event row disappeared before processing");
  }
  return row;
}

export async function insertWebhookEvent(
  db: Queryable,
  input: {
    readonly providerName: string;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly payloadJson: unknown;
  }
): Promise<WebhookEventInsertResult> {
  const result = await db.query(
    `WITH inserted AS (
       INSERT INTO webhook_events (
         provider_name, provider_event_id, event_type, payload_json, signature_valid
       )
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (provider_name, provider_event_id)
       WHERE provider_event_id IS NOT NULL
       DO NOTHING
       RETURNING id, provider_name, provider_event_id, event_type, signature_valid,
                 processed, processing_error, received_at, processed_at
     )
     SELECT id, provider_name, provider_event_id, event_type, signature_valid,
            processed, processing_error, received_at, processed_at,
            TRUE AS inserted
     FROM inserted
     UNION ALL
     SELECT id, provider_name, provider_event_id, event_type, signature_valid,
            processed, processing_error, received_at, processed_at,
            FALSE AS inserted
     FROM webhook_events
     WHERE provider_name = $1 AND provider_event_id = $2
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      input.providerName,
      input.providerEventId,
      input.eventType,
      JSON.stringify(input.payloadJson),
    ]
  );

  const row = result.rows[0] as (WebhookEventRow & { inserted: boolean }) | undefined;
  if (!row) {
    throw new Error("Webhook event insert did not return a row");
  }

  return {
    row,
    inserted: row.inserted,
  };
}

export async function markWebhookEventProcessed(
  db: Queryable,
  webhookEventId: string
): Promise<void> {
  await db.query(
    `UPDATE webhook_events
     SET processed = TRUE,
         processing_error = NULL,
         processed_at = NOW()
     WHERE id = $1`,
    [webhookEventId]
  );
}

export async function markWebhookEventFailed(
  db: Queryable,
  webhookEventId: string,
  message: string
): Promise<void> {
  await db.query(
    `UPDATE webhook_events
     SET processed = FALSE,
         processing_error = LEFT($2, 500),
         processed_at = NOW()
     WHERE id = $1`,
    [webhookEventId, message]
  );
}
