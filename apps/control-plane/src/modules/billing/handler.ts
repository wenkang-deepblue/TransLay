import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";
import type {
  ChangeSubscriptionPlanRequest,
  CheckoutRequest,
  CheckoutResponse,
  SessionConsumeResponse,
  SubscriptionStatus,
} from "@translay/shared-contracts";
import { findUserById } from "../../repositories/user-repo";
import {
  findSubscriptionByProviderId,
  getActiveSubscription,
  upsertProviderSubscription,
} from "../../repositories/subscription-repo";
import { upsertPaymentOrder } from "../../repositories/payment-order-repo";
import {
  insertWebhookEvent,
  lockWebhookEventForProcessing,
  markWebhookEventFailed,
  markWebhookEventProcessed,
} from "../../repositories/webhook-event-repo";
import { sendError } from "../../utils/errors";
import type { SubscriptionRow } from "../../repositories/subscription-repo";

type FetchLike = typeof fetch;
type ManagedPlanType = "pro_monthly" | "pro_yearly";
const PADDLE_API_TIMEOUT_MS = 5000;
const PADDLE_WEBHOOK_FUTURE_SKEW_SECONDS = 60;

type PaddleApiSubscriptionItem = {
  readonly price_id: string | null;
  readonly quantity: number;
};

type PaddleApiSubscription = {
  readonly id: string;
  readonly userId: string;
  readonly planType: ManagedPlanType;
  readonly status: SubscriptionStatus;
  readonly customerId: string | null;
  readonly currency: string | null;
  readonly amount: string | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly items: readonly PaddleApiSubscriptionItem[];
  readonly customData: Record<string, unknown> | null;
};

type PaddleSubscriptionEvent = {
  readonly id: string;
  readonly userId: string;
  readonly planType: "pro_monthly" | "pro_yearly";
  readonly status: SubscriptionStatus;
  readonly customerId: string | null;
  readonly currency: string | null;
  readonly amount: string | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
};

type PaddleTransactionEvent = {
  readonly id: string;
  readonly userId: string;
  readonly productType: "subscription" | "credits";
  readonly sku: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly checkoutId: string | null;
  readonly paidAt: Date | null;
  readonly status: "paid";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDate(value: unknown): Date | null {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function addYearsUtc(date: Date, years: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCFullYear(copy.getUTCFullYear() + years);
  return copy;
}

function addMonthsUtc(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function createPaddleApiAbortSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(PADDLE_API_TIMEOUT_MS)
    : undefined;
}

function calculateMonthlyToYearlyUpgradeAmountCents(config: AppConfig): number {
  return Math.max(
    0,
    config.billing.paddle.priceAmounts.pro_yearly - config.billing.paddle.priceAmounts.pro_monthly
  );
}

function formatCurrencyAmount(amountCents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}

function getCurrencyExponent(currency: string | null): number {
  switch ((currency ?? "USD").toUpperCase()) {
    case "BIF":
    case "CLP":
    case "DJF":
    case "GNF":
    case "JPY":
    case "KMF":
    case "KRW":
    case "MGA":
    case "PYG":
    case "RWF":
    case "UGX":
    case "VND":
    case "VUV":
    case "XAF":
    case "XOF":
    case "XPF":
      return 0;
    case "BHD":
    case "JOD":
    case "KWD":
    case "OMR":
    case "TND":
      return 3;
    default:
      return 2;
  }
}

function formatMinorUnitsAsMajorUnits(
  amountMinorUnits: string | null,
  currency: string | null
): string | null {
  if (!amountMinorUnits || !/^\d+$/.test(amountMinorUnits)) {
    return null;
  }

  const exponent = getCurrencyExponent(currency);
  if (exponent === 0) {
    return amountMinorUnits;
  }

  const padded = amountMinorUnits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, -exponent) || "0";
  const fractional = padded.slice(-exponent);
  return `${whole}.${fractional}`;
}

function timingSafeHexEquals(expectedHex: string, candidateHex: string): boolean {
  if (expectedHex.length !== candidateHex.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(candidateHex, "hex")
  );
}

function parsePaddleSignature(headerValue: string | string[] | undefined): {
  readonly timestamp: number;
  readonly signatures: string[];
} | null {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!header) {
    return null;
  }

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(";")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) {
      continue;
    }

    if (key === "ts") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
    } else if (key === "h1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

function verifyPaddleSignature(req: Request, config: AppConfig): boolean {
  const parsed = parsePaddleSignature(req.headers["paddle-signature"]);
  const rawBody = req.rawBody;
  if (!parsed || !rawBody || !config.billing.paddle.webhookSecret) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - parsed.timestamp > config.billing.paddle.webhookToleranceSeconds) {
    return false;
  }
  if (parsed.timestamp - nowSeconds > PADDLE_WEBHOOK_FUTURE_SKEW_SECONDS) {
    return false;
  }

  const payload = `${parsed.timestamp}:${rawBody.toString("utf8")}`;
  const expectedSignature = crypto
    .createHmac("sha256", config.billing.paddle.webhookSecret)
    .update(payload)
    .digest("hex");

  return parsed.signatures.some((candidate) => timingSafeHexEquals(expectedSignature, candidate));
}

function resolvePaddlePlanTypeFromPriceId(
  config: AppConfig,
  priceIds: readonly string[]
): "pro_monthly" | "pro_yearly" | null {
  for (const priceId of priceIds) {
    if (priceId === config.billing.paddle.priceIds.pro_monthly) {
      return "pro_monthly";
    }
    if (priceId === config.billing.paddle.priceIds.pro_yearly) {
      return "pro_yearly";
    }
  }
  return null;
}

function mapPaddleSubscriptionStatus(rawStatus: string | null): SubscriptionStatus {
  switch (rawStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "paused":
      return "paused";
    default:
      return "expired";
  }
}

function extractPriceIds(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const priceIds: string[] = [];
  for (const item of items) {
    if (!isObject(item)) {
      continue;
    }

    const directPriceId = readString(item.price_id);
    if (directPriceId) {
      priceIds.push(directPriceId);
      continue;
    }

    const price = isObject(item.price) ? item.price : null;
    const nestedPriceId = readString(price?.id);
    if (nestedPriceId) {
      priceIds.push(nestedPriceId);
    }
  }

  return priceIds;
}

function extractPaddleSubscriptionEvent(
  payload: Record<string, unknown>,
  config: AppConfig,
  fallbackUserId: string | null,
  fallbackPlanType: ManagedPlanType | null
): PaddleSubscriptionEvent | null {
  const data = isObject(payload.data) ? payload.data : null;
  if (!data) {
    return null;
  }

  const subscriptionId = readString(data.id);
  if (!subscriptionId) {
    return null;
  }

  const planType =
    resolvePaddlePlanTypeFromPriceId(config, extractPriceIds(data.items)) ??
    fallbackPlanType;
  if (!planType) {
    return null;
  }

  const customData = isObject(data.custom_data) ? data.custom_data : null;
  const userId = readString(customData?.user_id) ?? fallbackUserId;
  if (!userId) {
    return null;
  }

  const currentBillingPeriod = isObject(data.current_billing_period)
    ? data.current_billing_period
    : null;
  const scheduledChange = isObject(data.scheduled_change) ? data.scheduled_change : null;
  const scheduledAction = readString(scheduledChange?.action);
  const entitlementPeriodStart =
    readDate(customData?.translay_entitlement_period_start) ??
    readDate(currentBillingPeriod?.starts_at) ??
    readDate(currentBillingPeriod?.startsAt);
  const entitlementPeriodEnd =
    readDate(customData?.translay_entitlement_period_end) ??
    readDate(currentBillingPeriod?.ends_at) ??
    readDate(currentBillingPeriod?.endsAt);

  const currency = readString(data.currency_code);

  return {
    id: subscriptionId,
    userId,
    planType,
    status: mapPaddleSubscriptionStatus(readString(data.status)),
    customerId: readString(data.customer_id),
    currency,
    amount: formatMinorUnitsAsMajorUnits(
      readString(data.recurring_total) ?? readString(data.amount),
      currency
    ),
    currentPeriodStart: entitlementPeriodStart,
    currentPeriodEnd: entitlementPeriodEnd,
    cancelAtPeriodEnd: scheduledAction === "cancel",
  };
}

function extractPaddleTransactionEvent(
  payload: Record<string, unknown>,
  fallbackUserId: string | null
): PaddleTransactionEvent | null {
  const data = isObject(payload.data) ? payload.data : null;
  if (!data) {
    return null;
  }

  const transactionId = readString(data.id);
  if (!transactionId) {
    return null;
  }

  const customData = isObject(data.custom_data) ? data.custom_data : null;
  const userId = readString(customData?.user_id) ?? fallbackUserId;
  const productType = readString(customData?.product_type);
  const sku = readString(customData?.sku);
  if (!userId || !sku || (productType !== "subscription" && productType !== "credits")) {
    return null;
  }

  const details = isObject(data.details) ? data.details : null;
  const totals = isObject(details?.totals) ? details?.totals : null;
  const currency =
    readString(totals?.currency_code) ??
    readString(totals?.currencyCode) ??
    readString(data.currency_code);
  const amountMinorUnits =
    readString(totals?.grand_total) ??
    readString(totals?.grandTotal) ??
    readString(data.amount);

  return {
    id: transactionId,
    userId,
    productType,
    sku,
    amount: formatMinorUnitsAsMajorUnits(amountMinorUnits, currency),
    currency,
    customerId: readString(data.customer_id),
    subscriptionId: readString(data.subscription_id),
    checkoutId: readString(data.checkout_id),
    paidAt: readDate(data.billed_at) ?? readDate(data.created_at),
    status: "paid",
  };
}

function isSubscriptionPlanType(value: string | null): value is "pro_monthly" | "pro_yearly" {
  return value === "pro_monthly" || value === "pro_yearly";
}

function getPaddleApiBaseUrl(config: AppConfig): string {
  return config.billing.paddle.environment === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

function resolvePaddleApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isObject(payload)) {
    return fallback;
  }

  const errorObject = isObject(payload.error) ? payload.error : null;
  return (
    readString(errorObject?.detail) ??
    readString(errorObject?.message) ??
    readString(payload.message) ??
    fallback
  );
}

function isPaddleCancelPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not authorized to create subscription-cancel/i.test(message);
}

function readPaddleCancelManagementUrl(data: unknown): string | null {
  if (!isObject(data)) {
    return null;
  }

  const managementUrls = isObject(data.management_urls) ? data.management_urls : null;
  return readString(managementUrls?.cancel);
}

async function paddleApiRequest<T>(
  config: AppConfig,
  fetchImpl: FetchLike,
  path: string,
  init: {
    readonly method?: "GET" | "POST" | "PATCH";
    readonly body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const apiKey = config.billing.paddle.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Paddle API key is not configured");
  }

  const response = await fetchImpl(`${getPaddleApiBaseUrl(config)}${path}`, {
    method: init.method ?? "GET",
    signal: createPaddleApiAbortSignal(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      resolvePaddleApiErrorMessage(payload, "Paddle billing action failed")
    );
  }

  if (!isObject(payload)) {
    throw new Error("Paddle returned a malformed response");
  }
  if (isObject(payload.error)) {
    throw new Error(
      resolvePaddleApiErrorMessage(payload, "Paddle billing action failed")
    );
  }

  return (payload.data ?? payload) as T;
}

function normalizePaddleSubscriptionItems(items: unknown): PaddleApiSubscriptionItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const normalizedItems: PaddleApiSubscriptionItem[] = [];
  for (const item of items) {
    if (!isObject(item)) {
      continue;
    }

    const priceObject = isObject(item.price) ? item.price : null;
    const priceId = readString(item.price_id) ?? readString(priceObject?.id);
    const quantityValue =
      typeof item.quantity === "number"
        ? item.quantity
        : typeof item.quantity === "string"
          ? Number(item.quantity)
          : NaN;

    normalizedItems.push({
      price_id: priceId,
      quantity: Number.isFinite(quantityValue) && quantityValue > 0 ? quantityValue : 1,
    });
  }

  return normalizedItems;
}

function normalizePaddleApiSubscription(
  data: unknown,
  config: AppConfig,
  fallbackUserId: string
): PaddleApiSubscription | null {
  if (!isObject(data)) {
    return null;
  }

  const subscriptionId = readString(data.id);
  if (!subscriptionId) {
    return null;
  }

  const items = normalizePaddleSubscriptionItems(data.items);
  const planType = resolvePaddlePlanTypeFromPriceId(
    config,
    items
      .map((item) => item.price_id)
      .filter((priceId): priceId is string => Boolean(priceId))
  );
  if (!planType) {
    return null;
  }

  const customData = isObject(data.custom_data) ? data.custom_data : null;
  const currentBillingPeriod = isObject(data.current_billing_period)
    ? data.current_billing_period
    : null;
  const scheduledChange = isObject(data.scheduled_change) ? data.scheduled_change : null;
  const entitlementPeriodStart =
    readDate(customData?.translay_entitlement_period_start) ??
    readDate(currentBillingPeriod?.starts_at) ??
    readDate(currentBillingPeriod?.startsAt);
  const entitlementPeriodEnd =
    readDate(customData?.translay_entitlement_period_end) ??
    readDate(currentBillingPeriod?.ends_at) ??
    readDate(currentBillingPeriod?.endsAt);

  const currency = readString(data.currency_code);
  return {
    id: subscriptionId,
    userId: readString(customData?.user_id) ?? fallbackUserId,
    planType,
    status: mapPaddleSubscriptionStatus(readString(data.status)),
    customerId: readString(data.customer_id),
    currency,
    amount: formatMinorUnitsAsMajorUnits(
      readString(data.recurring_total) ?? readString(data.amount),
      currency
    ),
    currentPeriodStart: entitlementPeriodStart,
    currentPeriodEnd: entitlementPeriodEnd,
    cancelAtPeriodEnd: readString(scheduledChange?.action) === "cancel",
    items,
    customData,
  };
}

function resolveNextSubscriptionItems(
  currentItems: readonly PaddleApiSubscriptionItem[],
  targetPriceId: string
): Array<{ readonly price_id: string; readonly quantity: number }> {
  if (currentItems.length === 0) {
    return [{ price_id: targetPriceId, quantity: 1 }];
  }

  let replaced = false;
  const items = currentItems.map((item, index) => {
    const shouldReplace =
      !replaced
      && (index === 0 || item.price_id !== null);

    if (shouldReplace) {
      replaced = true;
      return {
        price_id: targetPriceId,
        quantity: item.quantity > 0 ? item.quantity : 1,
      };
    }

    return {
      price_id: item.price_id ?? targetPriceId,
      quantity: item.quantity > 0 ? item.quantity : 1,
    };
  });

  return replaced ? items : [{ price_id: targetPriceId, quantity: 1 }];
}

function buildPortalSubscriptionResponse(
  user: NonNullable<Awaited<ReturnType<typeof findUserById>>>,
  avatarUrl: string | null,
  subscription: SubscriptionRow
): SessionConsumeResponse {
  return {
    ok: true,
    user: {
      google_subject_id: user.google_subject_id,
      email: user.email,
      display_name: user.display_name,
      avatar_url: avatarUrl,
    },
    plan_type: subscription.plan_type,
    subscription_status: subscription.status,
    ...(subscription.plan_type !== "free" &&
      subscription.provider_name !== "none" && {
        subscription: {
          provider_name: subscription.provider_name,
          current_period_start: subscription.current_period_start?.toISOString() ?? "",
          current_period_end: subscription.current_period_end?.toISOString() ?? "",
          cancel_at_period_end: subscription.cancel_at_period_end,
        },
      }),
  };
}

async function resumePaddleSubscription(
  pool: Pool,
  redis: Redis,
  config: AppConfig,
  fetchImpl: FetchLike,
  user: NonNullable<Awaited<ReturnType<typeof findUserById>>>,
  avatarUrl: string | null,
  subscription: SubscriptionRow
): Promise<SessionConsumeResponse> {
  if (!subscription.provider_subscription_id) {
    throw new Error("Subscription is missing a provider subscription ID");
  }

  const updatedSubscriptionData = await paddleApiRequest<unknown>(
    config,
    fetchImpl,
    `/subscriptions/${subscription.provider_subscription_id}`,
    {
      method: "PATCH",
      body: {
        scheduled_change: null,
      },
    }
  );
  const normalizedUpdated = normalizePaddleApiSubscription(
    updatedSubscriptionData,
    config,
    user.id
  );
  if (!normalizedUpdated) {
    throw new Error("Paddle returned an unreadable subscription");
  }

  const updatedSubscription = await upsertProviderSubscription(pool, {
    userId: normalizedUpdated.userId,
    planType: normalizedUpdated.planType,
    status: normalizedUpdated.status,
    providerName: "paddle",
    providerCustomerId: normalizedUpdated.customerId,
    providerSubscriptionId: normalizedUpdated.id,
    currency: normalizedUpdated.currency,
    amount: normalizedUpdated.amount,
    currentPeriodStart: normalizedUpdated.currentPeriodStart,
    currentPeriodEnd: normalizedUpdated.currentPeriodEnd,
    cancelAtPeriodEnd: false,
  });
  await invalidateEntitlementCache(redis, updatedSubscription.user_id);

  return buildPortalSubscriptionResponse(user, avatarUrl, updatedSubscription);
}

async function createMonthlyToYearlyUpgradeCharge(
  config: AppConfig,
  fetchImpl: FetchLike,
  subscriptionId: string,
  amountCents: number
): Promise<unknown> {
  return paddleApiRequest<unknown>(
    config,
    fetchImpl,
    `/subscriptions/${subscriptionId}/charge`,
    {
      method: "POST",
      body: {
        effective_from: "immediately",
        items: [
          {
            quantity: 1,
            on_payment_failure: "prevent_change",
            price: {
              name: "TransLay Annual Commitment Upgrade",
              description: "Monthly to annual commitment upgrade",
              billing_cycle: null,
              trial_period: null,
              tax_mode: "account_setting",
              unit_price: {
                amount: String(amountCents),
                currency_code: "USD",
              },
              product: {
                name: "TransLay Annual Commitment Upgrade",
                tax_category: "standard",
                description: "One-time charge to upgrade TransLay from monthly to annual commitment.",
              },
            },
          },
        ],
      },
    }
  );
}

function isPaddleChargeAccepted(payload: unknown): boolean {
  if (!isObject(payload)) {
    return false;
  }
  const id = readString(payload.id);
  const status = readString(payload.status);
  if (id?.startsWith("sub_")) {
    return status === "active";
  }
  if (id?.startsWith("txn_")) {
    return status === "paid" || status === "completed";
  }
  return status === "paid" || status === "completed";
}

async function clearPaddleScheduledChange(
  config: AppConfig,
  fetchImpl: FetchLike,
  subscriptionId: string,
  userId: string
): Promise<PaddleApiSubscription> {
  const updatedSubscriptionData = await paddleApiRequest<unknown>(
    config,
    fetchImpl,
    `/subscriptions/${subscriptionId}`,
    {
      method: "PATCH",
      body: {
        scheduled_change: null,
      },
    }
  );
  const normalizedUpdated = normalizePaddleApiSubscription(
    updatedSubscriptionData,
    config,
    userId
  );
  if (!normalizedUpdated) {
    throw new Error("Paddle returned an unreadable subscription");
  }

  return normalizedUpdated;
}

async function upgradeMonthlyToYearlySubscription(
  pool: Pool,
  redis: Redis,
  config: AppConfig,
  fetchImpl: FetchLike,
  user: NonNullable<Awaited<ReturnType<typeof findUserById>>>,
  avatarUrl: string | null,
  activeSubscription: SubscriptionRow,
  normalizedCurrent: PaddleApiSubscription,
  confirmed: boolean
): Promise<SessionConsumeResponse> {
  const subscriptionId = normalizedCurrent.id;
  const targetPriceId = config.billing.paddle.priceIds.pro_yearly;
  if (!targetPriceId) {
    throw new Error("Billing is not configured");
  }

  const amountCents = calculateMonthlyToYearlyUpgradeAmountCents(config);
  if (!confirmed) {
    return {
      ...buildPortalSubscriptionResponse(user, avatarUrl, activeSubscription),
      billing_action: {
        type: "confirm_upgrade_charge",
        amount: amountCents,
        formatted_amount: formatCurrencyAmount(amountCents),
      },
    };
  }

  const wasCanceling =
    activeSubscription.cancel_at_period_end || normalizedCurrent.cancelAtPeriodEnd;
  let subscriptionForUpgrade = normalizedCurrent;

  const entitlementStart =
    activeSubscription.current_period_start ??
    subscriptionForUpgrade.currentPeriodStart ??
    new Date();
  const entitlementEnd = addYearsUtc(entitlementStart, 1);
  const nextCustomData = {
    ...(subscriptionForUpgrade.customData ?? {}),
    user_id: user.id,
    product_type: "subscription",
    sku: "pro_yearly",
    translay_entitlement_period_start: entitlementStart.toISOString(),
    translay_entitlement_period_end: entitlementEnd.toISOString(),
  };

  const charge = await createMonthlyToYearlyUpgradeCharge(
    config,
    fetchImpl,
    subscriptionId,
    amountCents
  );
  if (!isPaddleChargeAccepted(charge)) {
    throw new Error("Upgrade payment was not completed.");
  }

  if (wasCanceling) {
    subscriptionForUpgrade = await clearPaddleScheduledChange(
      config,
      fetchImpl,
      subscriptionId,
      user.id
    );
  }

  let updatedSubscriptionData: unknown;
  try {
    updatedSubscriptionData = await paddleApiRequest<unknown>(
      config,
      fetchImpl,
      `/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        body: {
          items: resolveNextSubscriptionItems(subscriptionForUpgrade.items, targetPriceId),
          proration_billing_mode: "do_not_bill",
          custom_data: nextCustomData,
        },
      }
    );
  } catch (error) {
    throw error;
  }
  const normalizedUpdated = normalizePaddleApiSubscription(
    updatedSubscriptionData,
    config,
    user.id
  );
  if (!normalizedUpdated) {
    throw new Error("Paddle returned an unreadable subscription");
  }

  const updatedSubscription = await upsertProviderSubscription(pool, {
    userId: normalizedUpdated.userId,
    planType: "pro_yearly",
    status: normalizedUpdated.status,
    providerName: "paddle",
    providerCustomerId: normalizedUpdated.customerId,
    providerSubscriptionId: normalizedUpdated.id,
    currency: normalizedUpdated.currency,
    amount: normalizedUpdated.amount,
    currentPeriodStart: entitlementStart,
    currentPeriodEnd: entitlementEnd,
    cancelAtPeriodEnd: false,
  });
  await invalidateEntitlementCache(redis, updatedSubscription.user_id);

  return {
    ...buildPortalSubscriptionResponse(user, avatarUrl, updatedSubscription),
    billing_action: {
      type: "upgrade_charged",
      amount: amountCents,
      formatted_amount: formatCurrencyAmount(amountCents),
    },
  } as SessionConsumeResponse & {
    readonly billing_action: {
      readonly type: "upgrade_charged";
      readonly amount: number;
      readonly formatted_amount: string;
    };
  };
}

async function invalidateEntitlementCache(redis: Redis, userId: string): Promise<void> {
  try {
    await redis.del(`entitlement:${userId}`);
  } catch (error) {
    console.warn("Failed to invalidate entitlement cache:", (error as Error).message);
  }
}

export function checkoutHandler(pool: Pool, config: AppConfig) {
  return async (req: Request, res: Response) => {
    const portalSession = req.portalSession;
    if (!portalSession) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const body = (req.body ?? {}) as CheckoutRequest;
    const productType = body.product_type ?? "subscription";
    const planType = body.plan_type;
    if (
      productType !== "subscription" ||
      (planType !== "pro_monthly" && planType !== "pro_yearly")
    ) {
      sendError(res, "INVALID_CHECKOUT_REQUEST");
      return;
    }

    const user = await findUserById(pool, portalSession.userId);
    if (!user) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const activeSubscription = await getActiveSubscription(pool, user.id);
    if (!activeSubscription) {
      sendError(res, "ACCESS_DENIED", "Subscription state is not initialized");
      return;
    }

    if (
      activeSubscription.plan_type !== "free" &&
      ["active", "grace_period", "past_due"].includes(activeSubscription.status)
    ) {
      sendError(
        res,
        "ACCESS_DENIED",
        "A paid subscription already exists for this account. Use the billing page to change it."
      );
      return;
    }

    const priceId = config.billing.paddle.priceIds[planType];
    if (!priceId) {
      sendError(res, "SERVICE_UNAVAILABLE", "Billing is not configured");
      return;
    }

    const response: CheckoutResponse = {
      provider_name: "paddle",
      price_id: priceId,
      custom_data: {
        user_id: user.id,
        product_type: "subscription",
        sku: planType,
      },
    };

    res.json(response);
  };
}

export function changeSubscriptionPlanHandler(
  pool: Pool,
  redis: Redis,
  config: AppConfig,
  fetchImpl: FetchLike = fetch
) {
  return async (req: Request, res: Response) => {
    const portalSession = req.portalSession;
    if (!portalSession) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const body = (req.body ?? {}) as ChangeSubscriptionPlanRequest;
    const targetPlanType = body.plan_type;
    if (!isSubscriptionPlanType(targetPlanType)) {
      sendError(res, "INVALID_CHECKOUT_REQUEST");
      return;
    }

    const user = await findUserById(pool, portalSession.userId);
    if (!user) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const activeSubscription = await getActiveSubscription(pool, user.id);
    if (
      !activeSubscription ||
      activeSubscription.plan_type === "free" ||
      activeSubscription.provider_name !== "paddle" ||
      !activeSubscription.provider_subscription_id ||
      !["active", "grace_period"].includes(activeSubscription.status)
    ) {
      sendError(
        res,
        "ACCESS_DENIED",
        "A paid Paddle subscription is required before you can change plans."
      );
      return;
    }

    if (activeSubscription.plan_type === "pro_yearly" && targetPlanType === "pro_monthly") {
      sendError(
        res,
        "ACCESS_DENIED",
        "Annual commitment is active. Monthly subscription is unavailable until the annual period ends."
      );
      return;
    }

    if (activeSubscription.plan_type === targetPlanType && !activeSubscription.cancel_at_period_end) {
      sendError(
        res,
        "ACCESS_DENIED",
        "This plan is already active for your account."
      );
      return;
    }

    if (activeSubscription.plan_type === targetPlanType && activeSubscription.cancel_at_period_end) {
      try {
        const response = await resumePaddleSubscription(
          pool,
          redis,
          config,
          fetchImpl,
          user,
          portalSession.avatarUrl ?? null,
          activeSubscription
        );
        res.json(response);
      } catch (error) {
        sendError(res, "SERVICE_UNAVAILABLE", (error as Error).message);
      }
      return;
    }

    const paddleSubscription = await paddleApiRequest<unknown>(
      config,
      fetchImpl,
      `/subscriptions/${activeSubscription.provider_subscription_id}`
    );
    const normalizedCurrent = normalizePaddleApiSubscription(
      paddleSubscription,
      config,
      user.id
    );
    if (!normalizedCurrent) {
      sendError(res, "SERVICE_UNAVAILABLE", "Unable to read your Paddle subscription.");
      return;
    }

    if (activeSubscription.plan_type === "pro_monthly" && targetPlanType === "pro_yearly") {
      try {
        const response = await upgradeMonthlyToYearlySubscription(
          pool,
          redis,
          config,
          fetchImpl,
          user,
          portalSession.avatarUrl ?? null,
          activeSubscription,
          normalizedCurrent,
          Boolean(body.confirm_upgrade_charge)
        );
        res.json(response);
      } catch (error) {
        sendError(res, "SERVICE_UNAVAILABLE", (error as Error).message);
      }
      return;
    }

    sendError(res, "ACCESS_DENIED", "This subscription change is not supported.");
  };
}

export function cancelSubscriptionHandler(
  pool: Pool,
  redis: Redis,
  config: AppConfig,
  fetchImpl: FetchLike = fetch
) {
  return async (req: Request, res: Response) => {
    const portalSession = req.portalSession;
    if (!portalSession) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const user = await findUserById(pool, portalSession.userId);
    if (!user) {
      sendError(res, "UNAUTHORIZED");
      return;
    }

    const activeSubscription = await getActiveSubscription(pool, user.id);
    if (
      !activeSubscription ||
      activeSubscription.plan_type === "free" ||
      activeSubscription.provider_name !== "paddle" ||
      !activeSubscription.provider_subscription_id ||
      !["active", "grace_period"].includes(activeSubscription.status)
    ) {
      sendError(
        res,
        "ACCESS_DENIED",
        "A paid Paddle subscription is required before you can cancel it."
      );
      return;
    }

    if (activeSubscription.cancel_at_period_end) {
      res.json(
        {
          ...buildPortalSubscriptionResponse(
            user,
            portalSession.avatarUrl ?? null,
            activeSubscription
          ),
          billing_action: {
            type: "already_canceled",
            period_end: activeSubscription.current_period_end?.toISOString() ?? null,
          },
        }
      );
      return;
    }

    let canceledSubscriptionData: unknown;
    try {
      canceledSubscriptionData = await paddleApiRequest<unknown>(
        config,
        fetchImpl,
        `/subscriptions/${activeSubscription.provider_subscription_id}/cancel`,
        {
          method: "POST",
          body: { effective_from: "next_billing_period" },
        }
      );
    } catch (error) {
      if (!isPaddleCancelPermissionError(error)) {
        throw error;
      }

      const subscriptionData = await paddleApiRequest<unknown>(
        config,
        fetchImpl,
        `/subscriptions/${activeSubscription.provider_subscription_id}`
      );
      const cancelUrl = readPaddleCancelManagementUrl(subscriptionData);
      if (!cancelUrl) {
        sendError(
          res,
          "SERVICE_UNAVAILABLE",
          "Paddle API key cannot cancel subscriptions and no customer portal cancel link was returned."
        );
        return;
      }

      res.json({
        ...buildPortalSubscriptionResponse(
          user,
          portalSession.avatarUrl ?? null,
          activeSubscription
        ),
        billing_action: {
          type: "redirect",
          url: cancelUrl,
        },
      });
      return;
    }

    const normalizedCanceled = normalizePaddleApiSubscription(
      canceledSubscriptionData,
      config,
      user.id
    );
    if (!normalizedCanceled) {
      sendError(res, "SERVICE_UNAVAILABLE", "Paddle returned an unreadable subscription.");
      return;
    }

    const canceledSubscription = await upsertProviderSubscription(pool, {
      userId: normalizedCanceled.userId,
      planType: normalizedCanceled.planType,
      status: normalizedCanceled.status,
      providerName: "paddle",
      providerCustomerId: normalizedCanceled.customerId,
      providerSubscriptionId: normalizedCanceled.id,
      currency: normalizedCanceled.currency,
      amount: normalizedCanceled.amount,
      currentPeriodStart: normalizedCanceled.currentPeriodStart,
      currentPeriodEnd: normalizedCanceled.currentPeriodEnd,
      cancelAtPeriodEnd: normalizedCanceled.cancelAtPeriodEnd,
    });
    await invalidateEntitlementCache(redis, canceledSubscription.user_id);

    res.json(
      buildPortalSubscriptionResponse(
        user,
        portalSession.avatarUrl ?? null,
        canceledSubscription
      )
    );
  };
}

export function paddleWebhookHandler(pool: Pool, redis: Redis, config: AppConfig) {
  return async (req: Request, res: Response) => {
    if (!verifyPaddleSignature(req, config)) {
      sendError(res, "WEBHOOK_SIGNATURE_INVALID");
      return;
    }

    const payload = isObject(req.body) ? req.body : null;
    const eventId = readString(payload?.event_id) ?? readString(payload?.eventId);
    const eventType = readString(payload?.event_type) ?? readString(payload?.eventType);
    if (!payload || !eventId || !eventType) {
      sendError(res, "INVALID_CHECKOUT_REQUEST", "Webhook payload is malformed");
      return;
    }

    const webhookEventResult = await insertWebhookEvent(pool, {
      providerName: "paddle",
      providerEventId: eventId,
      eventType,
      payloadJson: payload,
    });
    const webhookEvent = webhookEventResult.row;

    let duplicateProcessed = false;
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const lockedWebhookEvent = await lockWebhookEventForProcessing(client, webhookEvent.id);
        if (!webhookEventResult.inserted && lockedWebhookEvent.processed) {
          duplicateProcessed = true;
          await client.query("COMMIT");
        } else if (eventType.startsWith("subscription.")) {
          const existingSubscriptionId = readString(isObject(payload.data) ? payload.data.id : null);
          const existingSubscription = existingSubscriptionId
            ? await findSubscriptionByProviderId(client, "paddle", existingSubscriptionId)
            : null;
          const existingManagedPlanType =
            existingSubscription?.plan_type === "pro_monthly" ||
            existingSubscription?.plan_type === "pro_yearly"
              ? existingSubscription.plan_type
              : null;
          const normalizedSubscription = extractPaddleSubscriptionEvent(
            payload,
            config,
            existingSubscription?.user_id ?? null,
            existingManagedPlanType
          );

          if (normalizedSubscription) {
            await upsertProviderSubscription(client, {
              userId: normalizedSubscription.userId,
              planType: normalizedSubscription.planType,
              status: normalizedSubscription.status,
              providerName: "paddle",
              providerCustomerId: normalizedSubscription.customerId,
              providerSubscriptionId: normalizedSubscription.id,
              currency: normalizedSubscription.currency,
              amount: normalizedSubscription.amount,
              currentPeriodStart: normalizedSubscription.currentPeriodStart,
              currentPeriodEnd: normalizedSubscription.currentPeriodEnd,
              cancelAtPeriodEnd: normalizedSubscription.cancelAtPeriodEnd,
            });

            await invalidateEntitlementCache(redis, normalizedSubscription.userId);
          }
        } else if (eventType === "transaction.completed") {
          const subscriptionId = readString(isObject(payload.data) ? payload.data.subscription_id : null);
          const existingSubscription = subscriptionId
            ? await findSubscriptionByProviderId(client, "paddle", subscriptionId)
            : null;
          const normalizedTransaction = extractPaddleTransactionEvent(
            payload,
            existingSubscription?.user_id ?? null
          );

          if (normalizedTransaction) {
            await upsertPaymentOrder(client, {
              userId: normalizedTransaction.userId,
              providerName: "paddle",
              productType: normalizedTransaction.productType,
              sku: normalizedTransaction.sku,
              amount: normalizedTransaction.amount,
              currency: normalizedTransaction.currency,
              providerCheckoutId: normalizedTransaction.checkoutId,
              providerTransactionId: normalizedTransaction.id,
              providerSubscriptionId: normalizedTransaction.subscriptionId,
              status: normalizedTransaction.status,
              paidAt: normalizedTransaction.paidAt,
            });

            if (normalizedTransaction.productType === "subscription") {
              if (
                normalizedTransaction.subscriptionId &&
                isSubscriptionPlanType(normalizedTransaction.sku)
              ) {
                await upsertProviderSubscription(client, {
                  userId: normalizedTransaction.userId,
                  planType: normalizedTransaction.sku,
                  status: "active",
                  providerName: "paddle",
                  providerCustomerId: normalizedTransaction.customerId,
                  providerSubscriptionId: normalizedTransaction.subscriptionId,
                  currency: normalizedTransaction.currency,
                  amount: normalizedTransaction.amount,
                  currentPeriodStart:
                    existingSubscription?.current_period_start ??
                    normalizedTransaction.paidAt,
                  currentPeriodEnd:
                    existingSubscription?.current_period_end ??
                    (normalizedTransaction.paidAt
                      ? normalizedTransaction.sku === "pro_yearly"
                        ? addYearsUtc(normalizedTransaction.paidAt, 1)
                        : addMonthsUtc(normalizedTransaction.paidAt, 1)
                      : null),
                  cancelAtPeriodEnd: existingSubscription?.cancel_at_period_end ?? false,
                });
              }
              await invalidateEntitlementCache(redis, normalizedTransaction.userId);
            }
          }
        }

        if (!duplicateProcessed) {
          await markWebhookEventProcessed(client, webhookEvent.id);
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await markWebhookEventFailed(pool, webhookEvent.id, (error as Error).message);
      throw error;
    }

    res.json(duplicateProcessed ? { ok: true, duplicate: true } : { ok: true });
  };
}
