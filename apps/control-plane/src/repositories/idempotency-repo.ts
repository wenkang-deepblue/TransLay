import type { PoolClient, Pool } from "pg";
import type { UserId, JobId } from "@translay/shared-contracts";

export async function findIdempotencyRecord(
  pool: Pool,
  userId: UserId,
  idempotencyKey: string
): Promise<JobId | null> {
  const result = await pool.query(
    `SELECT job_id FROM idempotency_records
     WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > NOW()`,
    [userId, idempotencyKey]
  );
  return (result.rows[0]?.job_id as JobId) ?? null;
}

export async function insertIdempotencyRecord(
  client: PoolClient,
  params: {
    userId: UserId;
    idempotencyKey: string;
    jobId: JobId;
    requestFingerprint: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_records (user_id, idempotency_key, job_id, request_fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')`,
    [params.userId, params.idempotencyKey, params.jobId, params.requestFingerprint]
  );
}
