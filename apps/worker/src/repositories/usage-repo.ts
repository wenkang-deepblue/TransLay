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
    `WITH existing AS (
       SELECT id
         FROM usage_ledgers
        WHERE user_id = $1
          AND job_id IS NOT DISTINCT FROM $2
          AND host_type = $3
          AND usage_unit = $4
          AND quantity = $5
          AND billing_period_key = $6
          AND reason = $7
          AND slide_index IS NOT DISTINCT FROM $8
          AND ledger_stage = $9
          AND related_usage_id IS NOT DISTINCT FROM $10
        LIMIT 1
     ),
     inserted AS (
       INSERT INTO usage_ledgers (
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
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM existing
     LIMIT 1`,
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

  if (!result.rows[0]?.id) {
    throw new Error("Usage ledger insert did not return an id");
  }

  return result.rows[0].id;
}
