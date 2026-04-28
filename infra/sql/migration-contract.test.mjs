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
