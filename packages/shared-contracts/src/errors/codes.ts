/** All machine-readable error codes returned by the API. */
export const ERROR_CODES = {
  // 400
  INVALID_RANGE: { status: 400, message: "Invalid range expression" },
  UNSUPPORTED_LANGUAGE: { status: 400, message: "Language could not be recognized" },
  INVALID_TICKET: { status: 400, message: "Ticket is invalid, expired, or malformed" },

  // 401
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  INVALID_TOKEN: { status: 401, message: "Token verification failed" },

  // 403
  QUOTA_EXCEEDED: { status: 403, message: "Usage quota exceeded" },
  ACCESS_DENIED: { status: 403, message: "Current subscription does not permit this operation" },

  // 409
  CONCURRENT_JOB_RUNNING: { status: 409, message: "A translation job is already in progress" },
  IDEMPOTENT_REPLAY: { status: 409, message: "This request has already been processed" },
  TICKET_ALREADY_CONSUMED: { status: 409, message: "Ticket has already been consumed" },

  // 429
  RATE_LIMITED: { status: 429, message: "Too many requests" },

  // 500
  LLM_PROVIDER_ERROR: { status: 500, message: "Translation provider error" },
  GOOGLE_API_RATE_LIMIT: { status: 500, message: "Google Workspace™ API rate limit" },
  JOB_INTERNAL_ERROR: { status: 500, message: "Internal job processing error" },

  // 502
  HOST_ADAPTER_ERROR: { status: 502, message: "Document extraction or write-back error" },
  WEBHOOK_SIGNATURE_INVALID: { status: 502, message: "Webhook signature verification failed" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Unified API error response shape. */
export interface ApiError {
  readonly error: ErrorCode;
  readonly message: string;
}
