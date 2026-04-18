export interface VertexBudgetMetadata {
  readonly opName: string;
  readonly model?: string;
}

export interface VertexCallBudgetOptions {
  readonly ratePerMinute?: number;
  readonly burst?: number;
  readonly maxAttempts?: number;
}

type SleepFn = (ms: number) => Promise<void>;

const DEFAULT_RATE_PER_MINUTE = 120;
const DEFAULT_BURST = 10;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

let sleep: SleepFn = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sharedBudget: VertexCallBudget | null = null;

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

export class VertexQuotaExhausted extends Error {
  readonly code = "VERTEX_QUOTA_EXHAUSTED";
  readonly status = 429;

  constructor(
    readonly metadata: VertexBudgetMetadata,
    readonly attempts: number,
    cause?: unknown
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : `Vertex quota exhausted for ${metadata.opName} after ${attempts} attempt(s)`
    );
    this.name = "VertexQuotaExhausted";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class VertexCallBudget {
  private readonly bucket: TokenBucket;
  private readonly maxAttempts: number;

  constructor(options: VertexCallBudgetOptions = {}) {
    this.bucket = new TokenBucket(
      options.ratePerMinute ?? envInt("VERTEX_GENERATE_CONTENT_RATE_PER_MINUTE", DEFAULT_RATE_PER_MINUTE),
      options.burst ?? envInt("VERTEX_GENERATE_CONTENT_BURST", DEFAULT_BURST)
    );
    this.maxAttempts = options.maxAttempts ?? envInt("VERTEX_CALL_BUDGET_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
  }

  async generateContent<T>(
    callable: () => Promise<T>,
    metadata: VertexBudgetMetadata
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.bucket.take();
      console.info(
        "[vertex-budget] attempt",
        JSON.stringify({
          op_name: metadata.opName,
          model: metadata.model,
          attempt,
        })
      );
      try {
        return await callable();
      } catch (error) {
        lastError = error;
        if (!isRetryableVertexError(error) || attempt >= this.maxAttempts) {
          break;
        }
        const delayMs = resolveRetryDelayMs(error, attempt);
        console.warn(
          "[vertex-budget] throttled",
          JSON.stringify({
            op_name: metadata.opName,
            model: metadata.model,
            attempt,
            retry_delay_ms: delayMs,
          })
        );
        await sleep(delayMs);
      }
    }

    if (isRetryableVertexError(lastError) && isVertexQuotaSignal(lastError)) {
      throw new VertexQuotaExhausted(metadata, this.maxAttempts, lastError);
    }
    throw lastError;
  }
}

export function createVertexCallBudget(
  options: VertexCallBudgetOptions = {}
): VertexCallBudget {
  return new VertexCallBudget(options);
}

export function getVertexCallBudget(): VertexCallBudget {
  if (!sharedBudget) {
    sharedBudget = createVertexCallBudget();
  }
  return sharedBudget;
}

export function __setVertexBudgetSleepForTests(nextSleep: SleepFn): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Vertex budget test hooks are disabled in production");
  }
  sleep = nextSleep;
}

export function __resetVertexCallBudgetForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Vertex budget test hooks are disabled in production");
  }
  sharedBudget = null;
  sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRetryableVertexError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status === 503 || status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /resource exhausted|rate limit|too many requests|unavailable|timed out|timeout/i.test(error.message);
}

function isVertexQuotaSignal(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /resource exhausted|rate limit|too many requests|quota/i.test(error.message);
}

function getErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate = error as Error & {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }
  const match = candidate.message.match(/\bstatus\s+(\d{3})\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function resolveRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const baseDelayMs = Math.min(DEFAULT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), DEFAULT_BACKOFF_CAP_MS);
  return Math.max(1, Math.round(baseDelayMs * (0.7 + Math.random() * 0.6)));
}

function parseRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate = error as Error & {
    response?: {
      headers?: Headers | Record<string, string>;
    };
  };
  const headers = candidate.response?.headers;
  if (!headers) {
    return null;
  }

  const retryAfter =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers["retry-after"] ?? headers["Retry-After"];
  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const absolute = Date.parse(retryAfter);
  if (!Number.isNaN(absolute)) {
    return Math.max(0, absolute - Date.now());
  }

  return null;
}
