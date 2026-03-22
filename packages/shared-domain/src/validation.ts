import {
  HOST_TYPES,
  OUTPUT_MODES,
  RANGE_MODES,
  type HostType,
} from "@translay/shared-contracts";

/** Max total pages allowed in a single range expression (DoS prevention). */
const MAX_TOTAL_PAGES = 500;
/** Max comma-separated parts in a range expression. */
const MAX_RANGE_PARTS = 50;

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

  if (req.source_language_mode !== "auto")
    return "source_language_mode must be 'auto'";

  if (!req.target_language_input || typeof req.target_language_input !== "string")
    return "target_language_input is required";

  if (typeof req.target_language_input === "string" && req.target_language_input.length > 100)
    return "target_language_input exceeds maximum length";

  if (!req.output_mode || !OUTPUT_MODES.includes(req.output_mode as any))
    return `output_mode must be one of: ${OUTPUT_MODES.join(", ")}`;

  if (!req.range_mode || !RANGE_MODES.includes(req.range_mode as any))
    return `range_mode must be one of: ${RANGE_MODES.join(", ")}`;

  if (req.range_mode === "custom" && !req.range_expression)
    return "range_expression is required when range_mode is 'custom'";

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
  const parts = expr.split(",").map((s) => s.trim());
  if (parts.length > MAX_RANGE_PARTS) return null;

  const pages = new Set<number>();

  for (const part of parts) {
    if (!part) return null;

    if (part.includes("-")) {
      const segments = part.split("-");
      if (segments.length !== 2) return null;
      const start = parseInt(segments[0], 10);
      const end = parseInt(segments[1], 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end < start || end > MAX_TOTAL_PAGES)
        return null;
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 1 || num > MAX_TOTAL_PAGES) return null;
      pages.add(num);
    }

    if (pages.size > MAX_TOTAL_PAGES) return null;
  }

  return pages.size > 0 ? Array.from(pages).sort((a, b) => a - b) : null;
}
