type SlidesBudgetOpName = "expensive_read" | "batch_update";

export interface SlidesBudgetMetadata {
  readonly jobId?: string;
  readonly opName: string;
}

export interface SlidesCallBudgetOptions {
  readonly expensiveReadRatePerMinute?: number;
  readonly expensiveReadBurst?: number;
  readonly batchUpdateRatePerMinute?: number;
  readonly batchUpdateBurst?: number;
  readonly maxAttempts?: number;
}

type SleepFn = (ms: number) => Promise<void>;
type RandomFn = () => number;

const DEFAULT_EXPENSIVE_READ_RATE_PER_MINUTE = 50;
const DEFAULT_EXPENSIVE_READ_BURST = 10;
const DEFAULT_BATCH_UPDATE_RATE_PER_MINUTE = 60;
const DEFAULT_BATCH_UPDATE_BURST = 10;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

let sleep: SleepFn = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let random: RandomFn = () => Math.random();
let sharedBudget: SlidesCallBudget | null = null;

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerMinute: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
    this.lastRefillMs = Date.now();
  }

  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      await sleep(this.computeWaitMs());
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    if (elapsedMs === 0) {
      return;
    }

    const refillPerMs = this.ratePerMinute / 60_000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedMs * refillPerMs);
    this.lastRefillMs = now;
  }

  private computeWaitMs(): number {
    const refillPerMs = this.ratePerMinute / 60_000;
    if (refillPerMs <= 0) {
      return DEFAULT_BACKOFF_CAP_MS;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / refillPerMs));
  }
}

export class SlidesQuotaExhausted extends Error {
  readonly code = "SLIDES_QUOTA_EXHAUSTED";
  readonly status = 429;
  readonly response = { status: 429 };

  constructor(
    readonly metadata: SlidesBudgetMetadata,
    readonly attempts: number,
    cause?: unknown
  ) {
    super(
      `Slides quota exhausted for ${metadata.opName} after ${attempts} attempt(s)${
        metadata.jobId ? ` on job ${metadata.jobId}` : ""
      }`
    );
    this.name = "SlidesQuotaExhausted";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class SlidesCallBudget {
  private readonly expensiveReadBucket: TokenBucket;
  private readonly batchUpdateBucket: TokenBucket;
  private readonly maxAttempts: number;

  constructor(options: SlidesCallBudgetOptions = {}) {
    this.expensiveReadBucket = new TokenBucket(
      options.expensiveReadRatePerMinute ?? envInt("SLIDES_EXPENSIVE_READ_RATE_PER_MINUTE", DEFAULT_EXPENSIVE_READ_RATE_PER_MINUTE),
      options.expensiveReadBurst ?? envInt("SLIDES_EXPENSIVE_READ_BURST", DEFAULT_EXPENSIVE_READ_BURST)
    );
    this.batchUpdateBucket = new TokenBucket(
      options.batchUpdateRatePerMinute ?? envInt("SLIDES_BATCH_UPDATE_RATE_PER_MINUTE", DEFAULT_BATCH_UPDATE_RATE_PER_MINUTE),
      options.batchUpdateBurst ?? envInt("SLIDES_BATCH_UPDATE_BURST", DEFAULT_BATCH_UPDATE_BURST)
    );
    this.maxAttempts = options.maxAttempts ?? envInt("SLIDES_CALL_BUDGET_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
  }

  async expensiveRead<T>(
    callable: () => Promise<T>,
    metadata: SlidesBudgetMetadata
  ): Promise<T> {
    return this.runWithBudget("expensive_read", this.expensiveReadBucket, callable, metadata);
  }

  async batchUpdate<T>(
    callable: () => Promise<T>,
    metadata: SlidesBudgetMetadata
  ): Promise<T> {
    return this.runWithBudget("batch_update", this.batchUpdateBucket, callable, metadata);
  }

  async batchUpdateOnce<T>(
    callable: () => Promise<T>
  ): Promise<T> {
    await this.batchUpdateBucket.take();
    return callable();
  }

  private async runWithBudget<T>(
    budgetOp: SlidesBudgetOpName,
    bucket: TokenBucket,
    callable: () => Promise<T>,
    metadata: SlidesBudgetMetadata
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await bucket.take();
      try {
        return await callable();
      } catch (error) {
        lastError = error;
        if (!isRetryableSlidesError(error) || attempt >= this.maxAttempts) {
          break;
        }

        const retryDelayMs = resolveRetryDelayMs(error, attempt);
        console.warn(
          `[slides-budget] retrying ${budgetOp}`,
          JSON.stringify({
            job_id: metadata.jobId,
            op_name: metadata.opName,
            attempt,
            retry_delay_ms: retryDelayMs,
          })
        );
        await sleep(retryDelayMs);
      }
    }

    if (isRetryableSlidesError(lastError) && isSlidesQuotaSignal(lastError)) {
      throw new SlidesQuotaExhausted(metadata, this.maxAttempts, lastError);
    }
    throw lastError;
  }
}

export function createSlidesCallBudget(
  options: SlidesCallBudgetOptions = {}
): SlidesCallBudget {
  return new SlidesCallBudget(options);
}

export function getSlidesCallBudget(): SlidesCallBudget {
  if (!sharedBudget) {
    sharedBudget = createSlidesCallBudget();
  }
  return sharedBudget;
}

export function __setSlidesBudgetSleepForTests(nextSleep: SleepFn): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Slides budget test hooks are disabled in production");
  }
  sleep = nextSleep;
}

export function __resetSlidesCallBudgetForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Slides budget test hooks are disabled in production");
  }
  sharedBudget = null;
  sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  random = () => Math.random();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRetryableSlidesError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status === 503;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /quota|rate limit|resource exhausted|too many requests/i.test(error.message);
}

function isSlidesQuotaSignal(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /quota|rate limit|resource exhausted|too many requests/i.test(error.message);
}

function getErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const directStatus = [candidate.status, candidate.response?.status, candidate.code].find((value) =>
    typeof value === "number"
  );
  return typeof directStatus === "number" ? directStatus : null;
}

function resolveRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const baseDelayMs = Math.min(DEFAULT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), DEFAULT_BACKOFF_CAP_MS);
  const jitterMultiplier = 0.7 + random() * 0.6;
  return Math.max(1, Math.round(baseDelayMs * jitterMultiplier));
}

function parseRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const headers = getResponseHeaders(
    (error as Error & {
      response?: {
        headers?: unknown;
      };
    }).response?.headers
  );
  const raw = headers?.get("retry-after");
  if (!raw) {
    return null;
  }

  const asSeconds = Number.parseFloat(raw);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, Math.round(asSeconds * 1000));
  }

  const absoluteTime = Date.parse(raw);
  if (!Number.isNaN(absoluteTime)) {
    return Math.max(0, absoluteTime - Date.now());
  }

  return null;
}

function getResponseHeaders(rawHeaders: unknown): Headers | null {
  if (!rawHeaders) {
    return null;
  }

  if (rawHeaders instanceof Headers) {
    return rawHeaders;
  }

  const normalized = new Headers();
  if (typeof rawHeaders === "object") {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === "string") {
        normalized.set(key, value);
      }
    }
  }
  return normalized;
}
