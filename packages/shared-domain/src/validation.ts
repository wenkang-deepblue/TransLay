import {
  HOST_TYPES,
  OUTPUT_MODES,
  RANGE_MODES,
  SOURCE_LANGUAGE_MODES,
  type HostType,
  type OutputMode,
  type RangeMode,
  type SourceLanguageMode,
} from "@translay/shared-contracts";

/** Max total pages allowed in a single range expression (DoS prevention). */
const MAX_TOTAL_PAGES = 500;
/** Max comma-separated parts in a range expression. */
const MAX_RANGE_PARTS = 50;
/** Max length for target language input. */
const MAX_TARGET_LANGUAGE_INPUT_LENGTH = 100;
/** Keep custom language descriptions phrase-like rather than sentence-like. */
const MAX_TARGET_LANGUAGE_TOKENS = 8;

const TARGET_LANGUAGE_HARD_BLOCK_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,80}\b(previous|prior|above|all)\b.{0,60}\b(instruction|prompt|message|rule)s?\b/i,
  /\b(reveal|show|print|display|dump|leak|expose)\b.{0,80}\b(system prompt|developer message|hidden instructions?|internal instructions?)\b/i,
  /\b(role\s*:\s*(system|assistant|developer|user)|system prompt|developer message)\b.{0,80}\b(ignore|follow|respond|output|act as)\b/i,
  /\b(return|output|respond)\b.{0,40}\b(only|exactly)\b.{0,20}\b(json|yaml|xml|markdown)\b/i,
  /\b(do not translate|instead of translating|ignore the translation task)\b/i,
  /\b(act as|you are now|pretend to be)\b.{0,60}\b(ai|assistant|language model|translator|gemini|chatgpt)\b/i,
  /(忽略|无视|無視).{0,20}(之前|先前|以上|上面|前面).{0,20}(指令|说明|說明|提示|消息|讯息|訊息|规则|規則)/u,
  /(系统提示|系統提示|开发者消息|開發者消息|隐藏指令|隱藏指令|内部指令|內部指令)/u,
  /(只输出|只輸出|仅输出|僅輸出).{0,20}(json|yaml|xml|markdown)/iu,
];

const TARGET_LANGUAGE_DISALLOWED_CHARS = /[`"=:;{}[\]\\<>|]/u;
const TARGET_LANGUAGE_ALLOWED_CHARS = /^[\p{L}\p{M}\p{N}\s\-()\/,&'.]+$/u;

export function validateTargetLanguageInput(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) {
    return "target_language_input is required";
  }

  if (input.length > MAX_TARGET_LANGUAGE_INPUT_LENGTH) {
    return "target_language_input exceeds maximum length";
  }

  const normalized = normalizeTargetLanguageInput(input);
  if (normalized.length === 0) {
    return "target_language_input is required";
  }

  if (normalized.length < 2) {
    return "target_language_input must be at least 2 characters";
  }

  if (/[\r\n\t]/u.test(input)) {
    return "target_language_input must be a single-line language name or dialect description";
  }

  if (!/\p{L}/u.test(normalized)) {
    return "target_language_input must contain letter characters";
  }

  if (TARGET_LANGUAGE_DISALLOWED_CHARS.test(normalized) || !TARGET_LANGUAGE_ALLOWED_CHARS.test(normalized)) {
    return "target_language_input contains unsupported punctuation or control characters";
  }

  const tokenCount = normalized
    .split(/[\s/,&()'.-]+/u)
    .map((token) => token.trim())
    .filter(Boolean).length;
  if (tokenCount > MAX_TARGET_LANGUAGE_TOKENS) {
    return "target_language_input must be a short language name or dialect description";
  }

  if (TARGET_LANGUAGE_HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "target_language_input looks like prompt instructions, not a language name";
  }

  return null;
}

export const PAGE_RANGE_VALIDATION_ERROR_CODES = [
  "empty_input",
  "non_ascii_punctuation",
  "too_many_parts",
  "empty_segment",
  "invalid_range_segment",
  "zero_page",
  "negative_page",
  "decimal_page",
  "non_numeric",
  "reversed_range",
  "page_overflow",
] as const;
export type PageRangeValidationErrorCode =
  (typeof PAGE_RANGE_VALIDATION_ERROR_CODES)[number];

export interface PageRangeValidationError {
  readonly code: PageRangeValidationErrorCode;
  readonly token?: string;
  readonly message: string;
}

export interface PageRangeParseResult {
  readonly input_raw: string;
  readonly tokens: readonly string[];
  readonly resolved_pages: readonly number[];
  readonly deduplicated: boolean;
  readonly sorted: true;
  readonly validation_errors: readonly PageRangeValidationError[];
}

/** Validates a create-job request. Returns error message or null if valid. */
export function validateCreateJobRequest(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "Request body must be a JSON object";

  const req = body as Record<string, unknown>;

  if (!req.host_type || !HOST_TYPES.includes(req.host_type as HostType))
    return `host_type must be one of: ${HOST_TYPES.join(", ")}`;

  if (!req.document_id || typeof req.document_id !== "string")
    return "document_id is required";

  if (!req.document_name || typeof req.document_name !== "string")
    return "document_name is required";

  if (
    req.target_document_id !== undefined &&
    req.target_document_id !== null &&
    typeof req.target_document_id !== "string"
  ) {
    return "target_document_id must be a string when provided";
  }

  if (
    req.resubmit !== undefined &&
    typeof req.resubmit !== "boolean"
  ) {
    return "resubmit must be a boolean when provided";
  }

  if (
    !req.source_language_mode ||
    !SOURCE_LANGUAGE_MODES.includes(req.source_language_mode as SourceLanguageMode)
  ) {
    return `source_language_mode must be one of: ${SOURCE_LANGUAGE_MODES.join(", ")}`;
  }

  const targetLanguageError = validateTargetLanguageInput(req.target_language_input);
  if (targetLanguageError) {
    return targetLanguageError;
  }

  if (!req.output_mode || !OUTPUT_MODES.includes(req.output_mode as OutputMode))
    return `output_mode must be one of: ${OUTPUT_MODES.join(", ")}`;

  if (req.output_mode === "create_new_file" && !req.target_document_id) {
    return "target_document_id is required when output_mode is 'create_new_file'";
  }

  if (!req.range_mode || !RANGE_MODES.includes(req.range_mode as RangeMode))
    return `range_mode must be one of: ${RANGE_MODES.join(", ")}`;

  if (req.range_mode === "custom" && !req.range_expression)
    return "range_expression is required when range_mode is 'custom'";

  if (
    req.range_mode === "custom" &&
    typeof req.range_expression === "string" &&
    (req.host_type === "docs" || req.host_type === "slides")
  ) {
    const parsed = parsePageRangeDetailed(req.range_expression);
    if (parsed.validation_errors.length > 0) {
      return parsed.validation_errors[0]?.message ?? "Invalid range expression";
    }
  }

  if (!req.idempotency_key || typeof req.idempotency_key !== "string")
    return "idempotency_key is required";

  if (typeof req.idempotency_key === "string" && req.idempotency_key.length > 512)
    return "idempotency_key exceeds maximum length";

  return null;
}

/**
 * Parse Slides/Docs page range expression (e.g. "1,3,5-7").
 * Returns sorted unique page numbers, or null if invalid.
 * Capped at MAX_TOTAL_PAGES to prevent DoS via large ranges.
 */
export function parsePageRange(expr: string): number[] | null {
  const parsed = parsePageRangeDetailed(expr);
  return parsed.validation_errors.length > 0 ? null : [...parsed.resolved_pages];
}

function buildPageRangeError(
  code: PageRangeValidationErrorCode,
  message: string,
  token?: string
): PageRangeParseResult {
  return {
    input_raw: "",
    tokens: [],
    resolved_pages: [],
    deduplicated: false,
    sorted: true,
    validation_errors: [{ code, token, message }],
  };
}

function parsePositiveIntegerToken(token: string): {
  readonly value?: number;
  readonly error?: PageRangeValidationError;
} {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    return {
      error: {
        code: "empty_segment",
        token,
        message: "Range expression contains an empty segment.",
      },
    };
  }

  if (/^\d+\.\d+$/.test(trimmed)) {
    return {
      error: {
        code: "decimal_page",
        token,
        message: "Page numbers must be positive integers, not decimals.",
      },
    };
  }

  if (/^-\d+$/.test(trimmed)) {
    return {
      error: {
        code: "negative_page",
        token,
        message: "Page numbers must be positive integers.",
      },
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      error: {
        code: "non_numeric",
        token,
        message: "Range expression contains non-numeric characters.",
      },
    };
  }

  const value = Number(trimmed);
  if (value === 0) {
    return {
      error: {
        code: "zero_page",
        token,
        message: "Page numbers must start at 1.",
      },
    };
  }

  if (value > MAX_TOTAL_PAGES) {
    return {
      error: {
        code: "page_overflow",
        token,
        message: `Page numbers must not exceed ${MAX_TOTAL_PAGES}.`,
      },
    };
  }

  return { value };
}

export function parsePageRangeDetailed(expr: string): PageRangeParseResult {
  const inputRaw = expr;
  const trimmedExpr = expr.trim();
  if (!trimmedExpr) {
    return {
      ...buildPageRangeError("empty_input", "Range expression cannot be empty."),
      input_raw: inputRaw,
    };
  }

  if (/[，、﹐﹑－—–―]/.test(trimmedExpr)) {
    return {
      ...buildPageRangeError(
        "non_ascii_punctuation",
        "Range expression must use ASCII commas (,) and hyphens (-) only."
      ),
      input_raw: inputRaw,
    };
  }

  const tokens = trimmedExpr.split(",").map((token) => token.trim());
  if (tokens.length > MAX_RANGE_PARTS) {
    return {
      ...buildPageRangeError(
        "too_many_parts",
        `Range expression must not contain more than ${MAX_RANGE_PARTS} comma-separated parts.`
      ),
      input_raw: inputRaw,
      tokens,
    };
  }

  const pages = new Set<number>();
  let rawPageCount = 0;

  for (const token of tokens) {
    if (!token) {
      return {
        ...buildPageRangeError("empty_segment", "Range expression contains an empty segment.", token),
        input_raw: inputRaw,
        tokens,
      };
    }

    const hyphenCount = [...token].filter((char) => char === "-").length;
    if (hyphenCount > 1) {
      return {
        ...buildPageRangeError(
          "invalid_range_segment",
          "Each range segment must contain at most one hyphen.",
          token
        ),
        input_raw: inputRaw,
        tokens,
      };
    }

    if (token.includes("-")) {
      const [rawStart, rawEnd] = token.split("-");
      if (rawStart === undefined || rawEnd === undefined) {
        return {
          ...buildPageRangeError(
            "invalid_range_segment",
            "Range segment must be in the form start-end.",
            token
          ),
          input_raw: inputRaw,
          tokens,
        };
      }

      const start = parsePositiveIntegerToken(rawStart);
      if (start.error) {
        return {
          input_raw: inputRaw,
          tokens,
          resolved_pages: [],
          deduplicated: false,
          sorted: true,
          validation_errors: [start.error],
        };
      }

      const end = parsePositiveIntegerToken(rawEnd);
      if (end.error) {
        return {
          input_raw: inputRaw,
          tokens,
          resolved_pages: [],
          deduplicated: false,
          sorted: true,
          validation_errors: [end.error],
        };
      }

      if ((start.value ?? 0) > (end.value ?? 0)) {
        return {
          ...buildPageRangeError(
            "reversed_range",
            "Range start must be less than or equal to range end.",
            token
          ),
          input_raw: inputRaw,
          tokens,
        };
      }

      for (let page = start.value ?? 0; page <= (end.value ?? 0); page += 1) {
        rawPageCount += 1;
        pages.add(page);
      }
    } else {
      const parsed = parsePositiveIntegerToken(token);
      if (parsed.error) {
        return {
          input_raw: inputRaw,
          tokens,
          resolved_pages: [],
          deduplicated: false,
          sorted: true,
          validation_errors: [parsed.error],
        };
      }

      rawPageCount += 1;
      pages.add(parsed.value ?? 0);
    }

    if (pages.size > MAX_TOTAL_PAGES) {
      return {
        ...buildPageRangeError(
          "page_overflow",
          `Range expression resolves to more than ${MAX_TOTAL_PAGES} pages.`,
          token
        ),
        input_raw: inputRaw,
        tokens,
      };
    }
  }

  const resolvedPages = Array.from(pages).sort((a, b) => a - b);
  return {
    input_raw: inputRaw,
    tokens,
    resolved_pages: resolvedPages,
    deduplicated: resolvedPages.length !== rawPageCount,
    sorted: true,
    validation_errors: [],
  };
}

function normalizeTargetLanguageInput(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
