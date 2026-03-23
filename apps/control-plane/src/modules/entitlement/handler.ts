import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { EntitlementResponse, MeteredUsageSnapshot } from "@translay/shared-contracts";
import { computeEntitlement } from "@translay/shared-domain";
import { getQuotaLimits, billingPeriodKey } from "@translay/shared-domain";
import { getActiveSubscription } from "../../repositories/subscription-repo";
import { getUsageSummary } from "../../repositories/usage-repo";
import { sendError } from "../../utils/errors";

export function entitlementHandler(pool: Pool) {
  return async (req: Request, res: Response) => {
    const auth = req.authContext;
    if (!auth) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const sub = await getActiveSubscription(pool, auth.user_id);
    if (!sub) {
      sendError(res, "JOB_INTERNAL_ERROR", "No subscription found");
      return;
    }

    const entitlement = computeEntitlement({
      plan_type: sub.plan_type,
      subscription_status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: sub.current_period_end,
    });

    const periodKey = billingPeriodKey();
    const limits = getQuotaLimits(sub.plan_type);
    const usage = await getUsageSummary(pool, auth.user_id, periodKey);

    const usageSnapshot: MeteredUsageSnapshot = {
      period_key: periodKey,
      slides_used: usage.slides_used,
      slides_limit: limits.slides,
      docs_pages_used: usage.docs_pages_used,
      docs_pages_limit: limits.docs_pages,
      sheets_cells_used: usage.sheets_cells_used,
      sheets_cells_limit: limits.sheets_cells,
    };

    const response: EntitlementResponse = {
      user: {
        google_subject_id: auth.identity.google_subject_id,
        email: auth.identity.email,
        display_name: auth.identity.display_name,
      },
      access: entitlement.access,
      plan_type: sub.plan_type,
      subscription_status: sub.status,
      ...(sub.plan_type !== "free" &&
        sub.provider_name !== "none" && {
          subscription: {
            provider_name: sub.provider_name,
            current_period_end: sub.current_period_end?.toISOString() ?? "",
            cancel_at_period_end: sub.cancel_at_period_end,
          },
        }),
      usage: usageSnapshot,
      cache_ttl_seconds: 300,
    };

    res.json(response);
  };
}
