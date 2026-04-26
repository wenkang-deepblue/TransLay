import type { PoolClient } from "pg";
import type { HostType, UserId, JobId, PlanType } from "@translay/shared-contracts";

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

export async function getActivePlanForUser(
  client: PoolClient,
  userId: UserId | string
): Promise<PlanType> {
  const result = await client.query<{ plan_type: PlanType }>(
    `SELECT plan_type
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY
       CASE WHEN status IN ('active', 'grace_period') THEN 0 ELSE 1 END,
       CASE WHEN plan_type != 'free' THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 1`,
    [userId]
  );

  return result.rows[0]?.plan_type ?? "free";
}

export async function getUsageBeforeJob(
  client: PoolClient,
  params: {
    readonly userId: UserId | string;
    readonly jobId: JobId | string;
    readonly hostType: HostType;
    readonly periodKey: string;
  }
): Promise<number> {
  const result = await client.query<{ used: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(12,1) AS used
     FROM usage_ledgers
     WHERE user_id = $1
       AND billing_period_key = $2
       AND host_type = $3
       AND job_id IS DISTINCT FROM $4`,
    [params.userId, params.periodKey, params.hostType, params.jobId]
  );

  return toNumber(result.rows[0]?.used);
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
