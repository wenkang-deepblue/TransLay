import type { Pool } from "pg";
import type { GoogleIdentity, UserId } from "@translay/shared-contracts";

/**
 * Find-or-create user by google_subject_id, then ensure a free subscription exists.
 * I4: Both operations run in a single transaction for atomicity.
 * Returns the internal user UUID.
 */
export async function upsertUser(
  pool: Pool,
  identity: GoogleIdentity
): Promise<UserId> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO users (google_subject_id, email, display_name, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (google_subject_id)
       DO UPDATE SET
         email = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [identity.google_subject_id, identity.email, identity.display_name]
    );
    const userId = result.rows[0].id as UserId;

    // I3: Conditional insert prevents duplicate on concurrent first-login
    await client.query(
      `INSERT INTO subscriptions (user_id, plan_type, status, provider_name)
       SELECT $1, 'free', 'active', 'none'
       WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE user_id = $1)`,
      [userId]
    );

    await client.query("COMMIT");
    return userId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function findUserById(
  pool: Pool,
  userId: UserId | string
): Promise<{
  id: UserId;
  google_subject_id: string;
  email: string | null;
  display_name: string | null;
} | null> {
  const result = await pool.query(
    `SELECT id, google_subject_id, email, display_name FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}
