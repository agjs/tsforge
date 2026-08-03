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
  // The WHOLE body is guarded, not just the stringify. `err instanceof Error` invokes
  // a prototype trap, and Object.prototype.toString consults Symbol.toStringTag — a
  // revoked Proxy or a throwing getter makes either of those throw. Callers run this
  // inside a catch, AFTER the failure was contained, so a throw here would abort the
  // batch the catch exists to keep alive: a contained failure becoming a total one is
  // strictly worse than an ugly message.
  try {
    if (err instanceof Error) {
      return err.message;
    }

    if (typeof err === "string") {
      return err;
    }

    const json = JSON.stringify(err);

    if (typeof json === "string") {
      return json;
    }

    return String(err);
  } catch {
    return "an unprintable value was thrown";
  }
}
