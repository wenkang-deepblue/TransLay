import type { PoolClient } from "pg";
import type { HostType, UserId, JobId } from "@translay/shared-contracts";

export async function insertUsageLedger(
  client: PoolClient,
  params: {
    userId: UserId | string;
    jobId: JobId | string;
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
