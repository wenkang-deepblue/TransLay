import type { PoolClient } from "pg";
import type { UserId } from "@translay/shared-contracts";

export type CreditUnit = "slides_pages" | "docs_pages" | "sheets_cells";

interface CreditBalanceRow {
  user_id: string;
  slides_balance: string;
  docs_pages_balance: string;
  sheets_cells_balance: string;
}

export async function consumeCredits(
  client: PoolClient,
  input: {
    readonly userId: UserId | string;
    readonly jobId: string;
    readonly unit: CreditUnit;
    readonly units: number;
    readonly idempotencyKey: string;
  }
): Promise<void> {
  if (input.units <= 0) {
    return;
  }

  const existing = await client.query(
    `SELECT id FROM credit_ledger WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [input.userId, input.idempotencyKey]
  );
  if (existing.rows.length > 0) {
    return;
  }

  await ensureCreditBalance(client, input.userId);
  const balance = await lockCreditBalance(client, input.userId);
  const pendingRefundUnits = await getPendingRefundUnits(client, input.userId, input.unit);
  const rawBalance = getUnitBalance(balance, input.unit);
  const availableBalance = roundUnits(rawBalance - pendingRefundUnits);
  if (availableBalance < input.units) {
    throw new Error("Insufficient prepaid credit balance");
  }

  let remaining = input.units;
  const grants = await client.query<{
    id: string;
    refundable_units: string;
  }>(
    `WITH pending_refunds AS (
       SELECT
         cri.credit_grant_id,
         SUM(cri.units) AS pending_units
       FROM credit_refund_request_items cri
       JOIN credit_refund_requests crr ON crr.id = cri.refund_request_id
       WHERE crr.status IN ('submitted', 'approved')
       GROUP BY cri.credit_grant_id
     )
     SELECT
       cg.id,
       GREATEST(
         cg.purchased_units - cg.used_units - cg.refunded_units - COALESCE(pr.pending_units, 0),
         0
       )::numeric(12,1) AS refundable_units
     FROM credit_grants cg
     LEFT JOIN pending_refunds pr ON pr.credit_grant_id = cg.id
     WHERE cg.user_id = $1
       AND cg.unit = $2
       AND cg.purchased_units > cg.used_units + cg.refunded_units
       AND (cg.expires_at IS NULL OR cg.expires_at > NOW())
     ORDER BY cg.created_at ASC, cg.id ASC
     FOR UPDATE OF cg`,
    [input.userId, input.unit]
  );

  let firstGrantId: string | null = null;
  for (const grant of grants.rows) {
    if (remaining <= 0) {
      break;
    }
    const available = toNumber(grant.refundable_units);
    const consume = Math.min(available, remaining);
    if (consume <= 0) {
      continue;
    }
    firstGrantId ??= grant.id;
    await client.query(
      `UPDATE credit_grants
       SET used_units = used_units + $2
       WHERE id = $1`,
      [grant.id, consume]
    );
    remaining = roundUnits(remaining - consume);
  }

  if (remaining > 0) {
    throw new Error("Insufficient refundable credit grants");
  }

  const nextBalance = roundUnits(rawBalance - input.units);
  await updateUnitBalance(client, input.userId, input.unit, nextBalance);
  await client.query(
    `INSERT INTO credit_ledger (
       user_id, credit_grant_id, job_id, unit, delta, balance_after,
       reason, idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'consume', $7)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [
      input.userId,
      firstGrantId,
      input.jobId,
      input.unit,
      -1 * input.units,
      nextBalance,
      input.idempotencyKey,
    ]
  );
}

async function ensureCreditBalance(client: PoolClient, userId: UserId | string): Promise<void> {
  await client.query(
    `INSERT INTO credit_balances (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function lockCreditBalance(
  client: PoolClient,
  userId: UserId | string
): Promise<CreditBalanceRow> {
  const result = await client.query<CreditBalanceRow>(
    `SELECT user_id, slides_balance, docs_pages_balance, sheets_cells_balance
     FROM credit_balances
     WHERE user_id = $1
     FOR UPDATE`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Credit balance row was not initialized");
  }
  return row;
}

async function getPendingRefundUnits(
  client: PoolClient,
  userId: UserId | string,
  unit: CreditUnit
): Promise<number> {
  const result = await client.query<{ pending_units: string }>(
    `SELECT COALESCE(SUM(cri.units), 0)::numeric(12,1) AS pending_units
     FROM credit_refund_request_items cri
     JOIN credit_refund_requests crr ON crr.id = cri.refund_request_id
     WHERE crr.user_id = $1
       AND crr.unit = $2
       AND crr.status IN ('submitted', 'approved')`,
    [userId, unit]
  );
  return toNumber(result.rows[0]?.pending_units);
}

function getUnitBalance(row: CreditBalanceRow, unit: CreditUnit): number {
  switch (unit) {
    case "slides_pages":
      return toNumber(row.slides_balance);
    case "docs_pages":
      return toNumber(row.docs_pages_balance);
    case "sheets_cells":
      return toNumber(row.sheets_cells_balance);
  }
}

async function updateUnitBalance(
  client: PoolClient,
  userId: UserId | string,
  unit: CreditUnit,
  balance: number
): Promise<void> {
  const column =
    unit === "slides_pages"
      ? "slides_balance"
      : unit === "docs_pages"
        ? "docs_pages_balance"
        : "sheets_cells_balance";
  await client.query(
    `UPDATE credit_balances SET ${column} = $2 WHERE user_id = $1`,
    [userId, balance]
  );
}

function roundUnits(value: number): number {
  return Math.round(value * 10) / 10;
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
