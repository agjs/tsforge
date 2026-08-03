/** Narrow `unknown` to a record without a type assertion. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow `unknown` to an array of `unknown` (not `any[]`). */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A human-readable message for an unknown thrown value. `String(err)` on a plain
 *  object yields "[object Object]", which tells an operator nothing — and the lint
 *  rule that forbids it was catching a real legibility bug, not a style nit. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return typeof err === "string" ? err : JSON.stringify(err);
}
