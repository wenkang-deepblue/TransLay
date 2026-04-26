import type { Pool, PoolClient } from "pg";
import type { UserId } from "@translay/shared-contracts";

type Queryable = Pool | PoolClient;
export type CreditUnit = "slides_pages" | "docs_pages" | "sheets_cells";
export type CreditReason = "purchase" | "consume" | "refund" | "manual_adjustment";
export type CreditGrantSource = "pay_as_you_go" | "subscription_extra";

export interface CreditBalanceRow {
  user_id: string;
  slides_balance: string;
  docs_pages_balance: string;
  sheets_cells_balance: string;
}

export interface CreditBalanceSummary {
  slides_balance: number;
  docs_pages_balance: number;
  sheets_cells_balance: number;
  slides_refundable_units: number;
  slides_pending_refund_units: number;
}

export interface CreditRefundRequestSummary {
  refund_request_id: string;
  status: "submitted" | "completed" | "partially_completed" | "rejected";
  unit: CreditUnit;
  requested_units: number;
  refundable_units_remaining: number;
  items: CreditRefundReservationItem[];
}

export interface CreditRefundReservationItem {
  readonly creditGrantId: string;
  readonly orderId: string;
  readonly providerTransactionId: string;
  readonly units: number;
  readonly purchasedUnits: number;
  readonly amountPaid: string | null;
  readonly currency: string | null;
}

export interface QueuedCreditRefundRequest {
  readonly refundRequestId: string;
  readonly userId: string;
  readonly unit: CreditUnit;
  readonly requestedUnits: number;
  readonly reason: string | null;
  readonly items: CreditRefundReservationItem[];
}

export interface QueuedCreditRefundBatch {
  readonly requests: QueuedCreditRefundRequest[];
}

export type ProviderPendingCreditRefundRequest = QueuedCreditRefundRequest & {
  readonly providerRefundIds: string[];
};

export async function getCreditBalance(
  db: Queryable,
  userId: UserId | string
): Promise<CreditBalanceSummary> {
  const result = await db.query<
    CreditBalanceRow & {
      slides_refundable_units: string;
      slides_pending_refund_units: string;
    }
  >(
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
	       GREATEST(
	         COALESCE(cb.slides_balance, 0) - COALESCE(SUM(COALESCE(pr.pending_units, 0)), 0),
	         0
	       )::numeric(12,1) AS slides_balance,
       COALESCE(cb.docs_pages_balance, 0)::numeric(12,1) AS docs_pages_balance,
       COALESCE(cb.sheets_cells_balance, 0)::numeric(12,1) AS sheets_cells_balance,
       COALESCE(SUM(
	         CASE WHEN cg.unit = 'slides_pages'
	              THEN GREATEST(
	                cg.purchased_units - cg.used_units - cg.refunded_units - COALESCE(pr.pending_units, 0),
	                0
	              )
	              ELSE 0
	         END
	       ), 0)::numeric(12,1) AS slides_refundable_units,
       COALESCE(SUM(
         CASE WHEN cg.unit = 'slides_pages'
              THEN COALESCE(pr.pending_units, 0)
              ELSE 0
         END
       ), 0)::numeric(12,1) AS slides_pending_refund_units
     FROM users u
     LEFT JOIN credit_balances cb ON cb.user_id = u.id
	     LEFT JOIN credit_grants cg
	       ON cg.user_id = u.id
	      AND cg.purchased_units > cg.used_units + cg.refunded_units
	     LEFT JOIN pending_refunds pr ON pr.credit_grant_id = cg.id
	     WHERE u.id = $1
	     GROUP BY cb.slides_balance, cb.docs_pages_balance, cb.sheets_cells_balance`,
    [userId]
  );

  return {
    slides_balance: toNumber(result.rows[0]?.slides_balance),
    docs_pages_balance: toNumber(result.rows[0]?.docs_pages_balance),
    sheets_cells_balance: toNumber(result.rows[0]?.sheets_cells_balance),
    slides_refundable_units: toNumber(result.rows[0]?.slides_refundable_units),
    slides_pending_refund_units: toNumber(result.rows[0]?.slides_pending_refund_units),
  };
}

export async function createCreditRefundRequest(
  pool: Pool,
  input: {
    readonly userId: UserId | string;
    readonly unit: CreditUnit;
    readonly requestedUnits: number;
    readonly reason: string | null;
  }
): Promise<CreditRefundRequestSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureCreditBalance(client, input.userId);
    await lockCreditBalance(client, input.userId);

    const grants = await client.query<{
      id: string;
      order_id: string;
      provider_transaction_id: string;
      purchased_units: string;
      amount_paid: string | null;
      currency: string | null;
      available_units: string;
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
         cg.order_id,
         cg.provider_transaction_id,
         cg.purchased_units::numeric(12,1) AS purchased_units,
	         cg.amount_paid::text AS amount_paid,
	         cg.currency,
	         GREATEST(
	           cg.purchased_units - cg.used_units - cg.refunded_units - COALESCE(pr.pending_units, 0),
	           0
	         )::numeric(12,1) AS available_units
	       FROM credit_grants cg
	       LEFT JOIN pending_refunds pr ON pr.credit_grant_id = cg.id
	       WHERE cg.user_id = $1
	         AND cg.unit = $2
         AND cg.purchased_units > cg.used_units + cg.refunded_units
       ORDER BY cg.created_at ASC, cg.id ASC
       FOR UPDATE OF cg`,
      [input.userId, input.unit]
    );

    const totalAvailable = grants.rows.reduce(
      (sum, row) => sum + Math.max(0, toNumber(row.available_units)),
      0
    );
    if (input.requestedUnits > totalAvailable) {
      await client.query("ROLLBACK");
      return {
        refund_request_id: "",
        status: "submitted",
        unit: input.unit,
        requested_units: input.requestedUnits,
        refundable_units_remaining: totalAvailable,
        items: [],
      };
    }

    const request = await client.query<{ id: string }>(
      `INSERT INTO credit_refund_requests (user_id, unit, requested_units, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.userId, input.unit, input.requestedUnits, input.reason]
    );

    let remaining = input.requestedUnits;
    const items: CreditRefundReservationItem[] = [];
    for (const grant of grants.rows) {
      if (remaining <= 0) {
        break;
      }
      const available = Math.max(0, toNumber(grant.available_units));
      if (available <= 0) {
        continue;
      }
      const units = Math.min(available, remaining);
      await client.query(
        `INSERT INTO credit_refund_request_items (
           refund_request_id, credit_grant_id, order_id, units
         )
         VALUES ($1, $2, $3, $4)`,
        [request.rows[0].id, grant.id, grant.order_id, units]
      );
      items.push({
        creditGrantId: grant.id,
        orderId: grant.order_id,
        providerTransactionId: grant.provider_transaction_id,
        units,
        purchasedUnits: toNumber(grant.purchased_units),
        amountPaid: grant.amount_paid,
        currency: grant.currency,
      });
      remaining = roundCreditUnits(remaining - units);
    }

    await client.query("COMMIT");
    return {
      refund_request_id: request.rows[0].id,
      status: "submitted",
      unit: input.unit,
      requested_units: input.requestedUnits,
      refundable_units_remaining: roundCreditUnits(totalAvailable - input.requestedUnits),
      items,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function completeCreditRefundRequest(
  pool: Pool,
  input: {
    readonly userId: UserId | string;
    readonly refundRequestId: string;
    readonly unit: CreditUnit;
    readonly items: readonly CreditRefundReservationItem[];
    readonly providerName: "paddle";
    readonly providerRefundIds: readonly string[];
    readonly amountRefunded: string | null;
    readonly currency: string | null;
    readonly status?: "completed" | "partially_completed";
    readonly providerStatus?: string;
    readonly providerError?: string | null;
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureCreditBalance(client, input.userId);
    const balance = await lockCreditBalance(client, input.userId);

    const request = await client.query<{ id: string }>(
      `SELECT id
       FROM credit_refund_requests
       WHERE id = $1 AND user_id = $2 AND status = 'submitted'
       FOR UPDATE`,
      [input.refundRequestId, input.userId]
    );
    if (request.rows.length === 0) {
      throw new Error("Credit refund request is not in a completable state");
    }

    let nextBalance = getUnitBalance(balance, input.unit);
    for (const item of input.items) {
      const units = roundCreditUnits(item.units);
      nextBalance = roundCreditUnits(nextBalance - units);
      if (nextBalance < 0) {
        throw new Error("Credit refund would make balance negative");
      }

      const grantUpdate = await client.query(
        `UPDATE credit_grants
         SET refunded_units = refunded_units + $2
         WHERE id = $1
           AND user_id = $3
           AND unit = $4
           AND purchased_units >= used_units + refunded_units + $2`,
        [item.creditGrantId, units, input.userId, input.unit]
      );
      if (grantUpdate.rowCount !== 1) {
        throw new Error("Credit refund grant update failed");
      }

      await updateUnitBalance(client, input.userId, input.unit, nextBalance);
      await insertCreditLedger(client, {
        userId: input.userId,
        orderId: item.orderId,
        creditGrantId: item.creditGrantId,
        jobId: null,
        unit: input.unit,
        delta: -1 * units,
        balanceAfter: nextBalance,
        reason: "refund",
        idempotencyKey: `refund:${input.refundRequestId}:grant:${item.creditGrantId}`,
      });

      await client.query(
        `UPDATE payment_orders
         SET
           status = CASE
             WHEN EXISTS (
               SELECT 1
               FROM credit_grants
               WHERE order_id = $1
                 AND refunded_units < purchased_units
             )
             THEN 'partially_refunded'
             ELSE 'refunded'
           END,
           refunded_at = COALESCE(refunded_at, NOW()),
           updated_at = NOW()
         WHERE id = $1`,
        [item.orderId]
      );
    }

    await client.query(
      `UPDATE credit_refund_requests
       SET
         status = $7,
         reviewed_at = COALESCE(reviewed_at, NOW()),
         completed_at = NOW(),
         provider_name = $3,
         provider_refund_ids = $4::jsonb,
         provider_status = $8,
         provider_error = LEFT($9, 1000),
	         amount_refunded = COALESCE($5, amount_refunded),
	         currency = COALESCE($6, currency)
       WHERE id = $1 AND user_id = $2`,
      [
        input.refundRequestId,
        input.userId,
        input.providerName,
        JSON.stringify(input.providerRefundIds),
        input.amountRefunded,
        input.currency,
        input.status ?? "completed",
        input.providerStatus ?? "completed",
        input.providerError ?? null,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function markCreditRefundRequestProviderPending(
  pool: Pool,
  input: {
    readonly userId: UserId | string;
    readonly refundRequestId: string;
    readonly providerName: "paddle";
    readonly providerRefundIds: readonly string[];
    readonly providerStatus: string;
    readonly amountRefunded: string | null;
    readonly currency: string | null;
  }
): Promise<void> {
  await pool.query(
    `UPDATE credit_refund_requests
     SET
       provider_name = $3,
       provider_refund_ids = $4::jsonb,
       provider_status = $5,
       amount_refunded = $6,
       currency = $7,
       reviewed_at = COALESCE(reviewed_at, NOW())
     WHERE id = $1 AND user_id = $2 AND status = 'submitted'`,
    [
      input.refundRequestId,
      input.userId,
      input.providerName,
      JSON.stringify(input.providerRefundIds),
      input.providerStatus,
      input.amountRefunded,
      input.currency,
    ]
  );
}

export async function getNextQueuedCreditRefundRequest(
  pool: Pool
): Promise<QueuedCreditRefundRequest | null> {
  const batch = await getQueuedCreditRefundBatch(pool, 1);
  return batch.requests[0] ?? null;
}

export async function getQueuedCreditRefundBatch(
  pool: Pool,
  limit = 25
): Promise<QueuedCreditRefundBatch> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requests = await client.query<{
      id: string;
      user_id: string;
      unit: CreditUnit;
      requested_units: string;
      reason: string | null;
    }>(
      `SELECT id, user_id, unit, requested_units::numeric(12,1) AS requested_units, reason
       FROM credit_refund_requests
       WHERE status = 'submitted'
         AND provider_name IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM credit_refund_request_items cri
           JOIN credit_grants cg ON cg.id = cri.credit_grant_id
           JOIN credit_refund_request_items pending_cri
             ON pending_cri.refund_request_id != cri.refund_request_id
           JOIN credit_refund_requests pending
             ON pending.id = pending_cri.refund_request_id
           JOIN credit_grants pending_cg ON pending_cg.id = pending_cri.credit_grant_id
           WHERE cri.refund_request_id = credit_refund_requests.id
             AND pending.status = 'submitted'
             AND pending.provider_name = 'paddle'
             AND pending.provider_status IN ('pending', 'pending_approval')
             AND pending_cg.provider_transaction_id = cg.provider_transaction_id
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (requests.rows.length === 0) {
      await client.query("COMMIT");
      return { requests: [] };
    }

    const items = await client.query<{
      refund_request_id: string;
      credit_grant_id: string;
      order_id: string;
      provider_transaction_id: string;
      units: string;
      purchased_units: string;
      amount_paid: string | null;
      currency: string | null;
    }>(
      `SELECT
         cri.refund_request_id,
         cri.credit_grant_id,
         cri.order_id,
         cg.provider_transaction_id,
         cri.units::numeric(12,1) AS units,
         cg.purchased_units::numeric(12,1) AS purchased_units,
         cg.amount_paid::text AS amount_paid,
         cg.currency
       FROM credit_refund_request_items cri
       JOIN credit_grants cg ON cg.id = cri.credit_grant_id
       WHERE cri.refund_request_id = ANY($1::uuid[])
       ORDER BY cri.refund_request_id ASC, cri.created_at ASC, cri.id ASC`,
      [requests.rows.map((row) => row.id)]
    );
    await client.query("COMMIT");
    const itemsByRequestId = new Map<string, CreditRefundReservationItem[]>();
    for (const item of items.rows) {
      const requestItems = itemsByRequestId.get(item.refund_request_id) ?? [];
      requestItems.push({
        creditGrantId: item.credit_grant_id,
        orderId: item.order_id,
        providerTransactionId: item.provider_transaction_id,
        units: toNumber(item.units),
        purchasedUnits: toNumber(item.purchased_units),
        amountPaid: item.amount_paid,
        currency: item.currency,
      });
      itemsByRequestId.set(item.refund_request_id, requestItems);
    }

    return {
      requests: requests.rows.map((row) => ({
        refundRequestId: row.id,
        userId: row.user_id,
        unit: row.unit,
        requestedUnits: toNumber(row.requested_units),
        reason: row.reason,
        items: itemsByRequestId.get(row.id) ?? [],
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getNextProviderPendingCreditRefundRequest(
  pool: Pool
): Promise<ProviderPendingCreditRefundRequest | null> {
  const requests = await getProviderPendingCreditRefundRequests(pool, { limit: 1 });
  return requests[0] ?? null;
}

export async function getProviderPendingCreditRefundRequestsForUser(
  pool: Pool,
  userId: UserId | string,
  limit = 10
): Promise<ProviderPendingCreditRefundRequest[]> {
  return getProviderPendingCreditRefundRequests(pool, { userId, limit });
}

async function getProviderPendingCreditRefundRequests(
  pool: Pool,
  input: {
    readonly userId?: UserId | string;
    readonly limit: number;
  }
): Promise<ProviderPendingCreditRefundRequest[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requests = await client.query<{
      id: string;
      user_id: string;
      unit: CreditUnit;
      requested_units: string;
      reason: string | null;
      provider_refund_ids: unknown;
    }>(
      `SELECT
         id,
         user_id,
         unit,
         requested_units::numeric(12,1) AS requested_units,
         reason,
         provider_refund_ids
       FROM credit_refund_requests
       WHERE status = 'submitted'
         AND provider_name = 'paddle'
         AND provider_status IN ('pending', 'pending_approval')
         AND ($1::uuid IS NULL OR user_id = $1::uuid)
       ORDER BY reviewed_at ASC NULLS FIRST, created_at ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [input.userId ?? null, input.limit]
    );
    if (requests.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const items = await client.query<{
      refund_request_id: string;
      credit_grant_id: string;
      order_id: string;
      provider_transaction_id: string;
      units: string;
      purchased_units: string;
      amount_paid: string | null;
      currency: string | null;
    }>(
      `SELECT
         cri.refund_request_id,
         cri.credit_grant_id,
         cri.order_id,
         cg.provider_transaction_id,
         cri.units::numeric(12,1) AS units,
         cg.purchased_units::numeric(12,1) AS purchased_units,
         cg.amount_paid::text AS amount_paid,
         cg.currency
       FROM credit_refund_request_items cri
       JOIN credit_grants cg ON cg.id = cri.credit_grant_id
       WHERE cri.refund_request_id = ANY($1::uuid[])
       ORDER BY cri.refund_request_id ASC, cri.created_at ASC, cri.id ASC`,
      [requests.rows.map((row) => row.id)]
    );
    await client.query("COMMIT");

    const itemsByRequestId = new Map<string, CreditRefundReservationItem[]>();
    for (const item of items.rows) {
      const requestItems = itemsByRequestId.get(item.refund_request_id) ?? [];
      requestItems.push({
        creditGrantId: item.credit_grant_id,
        orderId: item.order_id,
        providerTransactionId: item.provider_transaction_id,
        units: toNumber(item.units),
        purchasedUnits: toNumber(item.purchased_units),
        amountPaid: item.amount_paid,
        currency: item.currency,
      });
      itemsByRequestId.set(item.refund_request_id, requestItems);
    }

    return requests.rows.map((row) => ({
      refundRequestId: row.id,
      userId: row.user_id,
      unit: row.unit,
      requestedUnits: toNumber(row.requested_units),
      reason: row.reason,
      providerRefundIds: Array.isArray(row.provider_refund_ids)
        ? row.provider_refund_ids.filter((value): value is string => typeof value === "string")
        : [],
      items: itemsByRequestId.get(row.id) ?? [],
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectCreditRefundRequest(
  pool: Pool,
  input: {
    readonly userId: UserId | string;
    readonly refundRequestId: string;
    readonly providerName: "paddle";
    readonly providerRefundIds: readonly string[];
    readonly providerStatus: string;
    readonly providerError: string;
  }
): Promise<void> {
  await pool.query(
    `UPDATE credit_refund_requests
     SET
       status = 'rejected',
       reviewed_at = NOW(),
       provider_name = $3,
       provider_refund_ids = $4::jsonb,
       provider_status = $5,
       provider_error = LEFT($6, 1000)
     WHERE id = $1 AND user_id = $2 AND status = 'submitted'`,
    [
      input.refundRequestId,
      input.userId,
      input.providerName,
      JSON.stringify(input.providerRefundIds),
      input.providerStatus,
      input.providerError,
    ]
  );
}

export async function grantPurchasedCredits(
  client: PoolClient,
  input: {
    readonly userId: UserId | string;
    readonly orderId: string;
    readonly providerName: "paddle";
    readonly providerTransactionId: string;
    readonly source: CreditGrantSource;
    readonly unit: CreditUnit;
    readonly units: number;
    readonly amountPaid: string | null;
    readonly currency: string | null;
    readonly idempotencyKey: string;
  }
): Promise<void> {
  const existing = await client.query(
    `SELECT id FROM credit_ledger WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [input.userId, input.idempotencyKey]
  );
  if (existing.rows.length > 0) {
    return;
  }

  await ensureCreditBalance(client, input.userId);
  const balance = await lockCreditBalance(client, input.userId);
  const nextBalance = getUnitBalance(balance, input.unit) + input.units;

  const grant = await client.query<{ id: string }>(
    `INSERT INTO credit_grants (
       user_id, order_id, provider_name, provider_transaction_id, source,
       unit, purchased_units, currency, amount_paid
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider_name, provider_transaction_id)
     DO UPDATE SET
       order_id = EXCLUDED.order_id,
       updated_at = NOW()
     RETURNING id`,
    [
      input.userId,
      input.orderId,
      input.providerName,
      input.providerTransactionId,
      input.source,
      input.unit,
      input.units,
      input.currency,
      input.amountPaid,
    ]
  );

  await updateUnitBalance(client, input.userId, input.unit, nextBalance);
  await insertCreditLedger(client, {
    userId: input.userId,
    orderId: input.orderId,
    creditGrantId: grant.rows[0].id,
    jobId: null,
    unit: input.unit,
    delta: input.units,
    balanceAfter: nextBalance,
    reason: "purchase",
    idempotencyKey: input.idempotencyKey,
  });
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

async function insertCreditLedger(
  client: PoolClient,
  input: {
    readonly userId: UserId | string;
    readonly orderId: string | null;
    readonly creditGrantId: string | null;
    readonly jobId: string | null;
    readonly unit: CreditUnit;
    readonly delta: number;
    readonly balanceAfter: number;
    readonly reason: CreditReason;
    readonly idempotencyKey: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO credit_ledger (
       user_id, order_id, credit_grant_id, job_id, unit, delta,
       balance_after, reason, idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [
      input.userId,
      input.orderId,
      input.creditGrantId,
      input.jobId,
      input.unit,
      input.delta,
      input.balanceAfter,
      input.reason,
      input.idempotencyKey,
    ]
  );
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

function roundCreditUnits(value: number): number {
  return Math.round(value * 10) / 10;
}
