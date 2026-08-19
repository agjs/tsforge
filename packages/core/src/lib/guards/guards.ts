/** Narrow `unknown` to a record without a type assertion. Excludes arrays:
 *  `typeof [] === "object"`, so the old check narrowed a JSON array to
 *  `Record<string, unknown>` — a hole reachable via untrusted model/config
 *  JSON (e.g. plan.ts narrowed a nested array to an `IStep`, and downstream
 *  field reads got `undefined` on a value the type system swore was an object).
 *  Callers wanting either shape have `isArray`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow `unknown` to an array of `unknown` (not `any[]`). */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
