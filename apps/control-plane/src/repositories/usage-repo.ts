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
       COALESCE(SUM(CASE WHEN host_type = 'slides' THEN quantity ELSE 0 END), 0)::numeric(12,1) AS slides_used,
       COALESCE(SUM(CASE WHEN host_type = 'docs' THEN quantity ELSE 0 END), 0)::numeric(12,1) AS docs_pages_used,
       COALESCE(SUM(CASE WHEN host_type = 'sheets' THEN quantity ELSE 0 END), 0)::numeric(12,1) AS sheets_cells_used,
       COUNT(DISTINCT job_id)::int AS total_jobs
     FROM usage_ledgers
     WHERE user_id = $1 AND billing_period_key = $2`,
    [userId, periodKey]
  );
  return {
    slides_used: toNumber(result.rows[0]?.slides_used),
    docs_pages_used: toNumber(result.rows[0]?.docs_pages_used),
    sheets_cells_used: toNumber(result.rows[0]?.sheets_cells_used),
    total_jobs: Number(result.rows[0]?.total_jobs ?? 0),
  };
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
    slideIndex?: number;
    ledgerStage?: string;
    relatedUsageId?: string;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO usage_ledgers (
       user_id,
       job_id,
       host_type,
       usage_unit,
       quantity,
       billing_period_key,
       reason,
       slide_index,
       ledger_stage,
       related_usage_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      params.userId,
      params.jobId,
      params.hostType,
      params.usageUnit,
      params.quantity,
      params.periodKey,
      params.reason,
      params.slideIndex ?? null,
      params.ledgerStage ?? "finalized",
      params.relatedUsageId ?? null,
    ]
  );

  return result.rows[0].id;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
