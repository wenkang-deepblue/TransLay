/**
 * S8: Verify Redis MULTI/EXEC succeeded. Throws if any command failed.
 * Shared across session and job handlers.
 */
export function assertMultiOk(
  results: Array<[Error | null, unknown]> | null,
  context: string
): void {
  if (!results) throw new Error(`Redis MULTI/EXEC returned null (${context})`);
  for (const [err] of results) {
    if (err) throw new Error(`Redis MULTI command failed (${context}): ${err.message}`);
  }
}
