import type { Pool, PoolClient } from "pg";
import type { HostType, UserId, JobId } from "@translay/shared-contracts";

export interface UsageSummary {
  slides_used: number;
  docs_pages_used: number;
  sheets_cells_used: number;
  total_jobs: number;
}

export async function getUsageSummary(
  pool: Pool,
  userId: UserId,
  periodKey: string
): Promise<UsageSummary> {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN host_type = 'slides' THEN quantity ELSE 0 END), 0)::int AS slides_used,
       COALESCE(SUM(CASE WHEN host_type = 'docs' THEN quantity ELSE 0 END), 0)::int AS docs_pages_used,
       COALESCE(SUM(CASE WHEN host_type = 'sheets' THEN quantity ELSE 0 END), 0)::int AS sheets_cells_used,
       COUNT(DISTINCT job_id)::int AS total_jobs
     FROM usage_ledgers
     WHERE user_id = $1 AND billing_period_key = $2`,
    [userId, periodKey]
  );
  return result.rows[0];
}

export async function insertUsageLedger(
  client: PoolClient,
  params: {
    userId: UserId;
    jobId: JobId;
    hostType: HostType;
    usageUnit: string;
    quantity: number;
    periodKey: string;
    reason: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO usage_ledgers (user_id, job_id, host_type, usage_unit, quantity, billing_period_key, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.userId,
      params.jobId,
      params.hostType,
      params.usageUnit,
      params.quantity,
      params.periodKey,
      params.reason,
    ]
  );
}
