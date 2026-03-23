import type { Response } from "express";
import { ERROR_CODES, type ErrorCode } from "@translay/shared-contracts";

/**
 * Send a structured error response using the centralized ERROR_CODES registry.
 * Optional override message for more context; falls back to the registry default.
 */
export function sendError(
  res: Response,
  code: ErrorCode,
  message?: string
): void {
  const entry = ERROR_CODES[code];
  res.status(entry.status).json({
    error: code,
    message: message ?? entry.message,
  });
}
