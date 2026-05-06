import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("job idempotency records are unique per user, not globally", async () => {
  const migrationSql = await readFile(
    new URL("./migrations/038_scope_idempotency_records_by_user.sql", import.meta.url),
    "utf8"
  );

  assert.match(migrationSql, /DROP CONSTRAINT IF EXISTS uq_idempotency_key/);
  assert.match(migrationSql, /ADD CONSTRAINT uq_idempotency_user_key\s+UNIQUE \(user_id, idempotency_key\)/);
});

test("drive cleanup migration tracks permission ids and bounded cleanup state", async () => {
  const migrationSql = await readFile(
    new URL("./migrations/039_add_drive_cleanup_columns_to_translation_jobs.sql", import.meta.url),
    "utf8"
  );

  assert.match(migrationSql, /source_worker_permission_id TEXT/);
  assert.match(migrationSql, /target_worker_permission_id TEXT/);
  assert.match(migrationSql, /drive_cleanup_status TEXT NOT NULL DEFAULT 'not_required'/);
  assert.match(migrationSql, /CHECK \(drive_cleanup_status IN \('not_required', 'pending', 'succeeded', 'failed'\)\)/);
  assert.match(migrationSql, /CHECK \(drive_cleanup_attempts >= 0\)/);
});
