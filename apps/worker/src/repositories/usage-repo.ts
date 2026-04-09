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
