/** Narrow `unknown` to a record without a type assertion. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow `unknown` to an array of `unknown` (not `any[]`). */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * A human-readable message for an unknown thrown value.
 *
 * `String(err)` on a plain object yields "[object Object]", which tells an operator
 * nothing — that legibility bug is why this exists. But it must be TOTAL: callers
 * run it in a catch, after the failure has already been contained, so throwing here
 * would abort the very batch the catch is protecting. JSON.stringify throws on
 * BigInt, circular structures and a throwing `toJSON`, and returns `undefined` for
 * `undefined`, symbols and functions — so neither it nor `String()` is trusted
 * without a fallback.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === "string") {
    return err;
  }

  try {
    const json = JSON.stringify(err);

    if (typeof json === "string") {
      return json;
    }
  } catch {
    // Circular, BigInt, or a toJSON that throws — fall through.
  }

  try {
    return String(err);
  } catch {
    // A Symbol, or an object with a throwing toString.
    return Object.prototype.toString.call(err);
  }
}
