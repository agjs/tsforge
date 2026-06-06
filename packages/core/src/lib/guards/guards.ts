/** Narrow `unknown` to a record without a type assertion. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow `unknown` to an array of `unknown` (not `any[]`). */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
