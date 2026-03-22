import type { PlanType, HostType } from "@translay/shared-contracts";

export interface QuotaLimits {
  readonly slides: number;
  readonly docs_pages: number;
  readonly sheets_cells: number;
}

/**
 * Per-host per-period ceilings for each plan.
 *
 * Free tier also has a separate frequency constraint: max 1 job per billing period.
 * That constraint is enforced at the service layer (not here), because it spans
 * across host types and requires DB state. The values below are per-job size caps
 * that apply when a free-tier job IS allowed.
 */
const PLAN_LIMITS: Record<PlanType, QuotaLimits> = {
  free: { slides: 50, docs_pages: 10, sheets_cells: 25000 },
  pro_monthly: { slides: 300, docs_pages: 100, sheets_cells: 40000 },
  pro_yearly: { slides: 500, docs_pages: 200, sheets_cells: 100000 },
};

/** Max jobs per billing period for free-tier users. */
export const FREE_TIER_MAX_JOBS_PER_PERIOD = 1;

export function getQuotaLimits(plan: PlanType): QuotaLimits {
  return PLAN_LIMITS[plan];
}

export function getHostLimit(limits: QuotaLimits, hostType: HostType): number {
  switch (hostType) {
    case "slides":
      return limits.slides;
    case "docs":
      return limits.docs_pages;
    case "sheets":
      return limits.sheets_cells;
    default: {
      const _exhaustive: never = hostType;
      throw new Error(`Unknown host type: ${_exhaustive}`);
    }
  }
}

export function getRemainingQuota(
  plan: PlanType,
  hostType: HostType,
  used: number
): number {
  const limit = getHostLimit(PLAN_LIMITS[plan], hostType);
  return Math.max(0, limit - used);
}

/** Returns the billing period key for a given date. Uses UTC (e.g. "2026-03"). */
export function billingPeriodKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
