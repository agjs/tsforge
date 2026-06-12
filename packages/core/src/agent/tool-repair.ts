/**
 * Cost-ordered tool-call repair ladder for open-model reliability.
 *
 * The harness mediates between the model's output distribution and strict tool
 * schemas — rejecting RECOVERABLE noise that commercial models absorb invisibly.
 * As tsforge grows, this is the one place that keeps every new tool forgiving
 * the same way (CommandCode: "open model bad at tool calling is a harness
 * problem" — failure modes are a small finite set).
 *
 * CRITICAL ordering: VALIDATE THEN REPAIR, never preprocess-then-validate. We
 * only touch input the tool's own parser has ALREADY rejected — so a valid
 * input (e.g. file `content` that happens to be JSON-shaped) is never rewritten.
 * The parser is the prior; we spend repair budget only where it disagreed.
 *
 * The ladder (cost-ordered, earliest-win):
 *
 *  L0: null-drop, autolink-unwrap — lossless, always safe. Applied first.
 *
 *  L1: schema coercion — against the tool's declared params:
 *      - stringified arrays: '["a"]' → ["a"] (when param type is array)
 *      - stringified numbers/booleans: "42"→42, "true"→true (when typed)
 *      - single string → [string] for array params
 *      - trim markdown fences from paths (```path``` → path)
 *
 *  L2: safe defaults — ONLY where unambiguous (rare; study per-tool failures):
 *      - bool params default to true (unusual, but seen when model guesses)
 *      - (expand as telemetry surfaces safe patterns; bias toward L3 re-ask)
 *
 *  L3: re-ask — when not recoverable:
 *      - `recoverable: false` + targeted `feedback` (field, type, example)
 *      - turn.ts routes through as the tool result; loop re-asks the model
 *      - analyze-malformed.ts histograms re-ask rate per rule
 */

export interface IRepairResult {
  readonly args: Record<string, unknown>;
  readonly applied: readonly string[]; // e.g. ["drop-null:limit", "coerce:files"]
  readonly recoverable: boolean; // false → re-ask via feedback
  readonly feedback?: string; // targeted error text for the re-ask path
}

/**
 * Run the repair ladder on args that failed schema validation. Returns
 * the repaired args, a list of applied repair names (for telemetry), whether
 * the result is usable, and (if not) targeted feedback for the model.
 * Applies repairs in order: L0 (lossless) → L1 (schema coerce) → L2 (defaults)
 * → L3 (feedback if still broken).
 */
export function repairArgs(args: Record<string, unknown>): IRepairResult {
  const applied: string[] = [];
  let out = args;

  // L0: Lossless repairs (null-drop, autolink-unwrap).
  out = applyL0(out, applied);

  // L1: Schema coercion (stringified arrays, numbers, booleans, markdown fences).
  // For now, we have no schema context here — deferred to handlers that know
  // their field types (toEdits, toCreate, etc.). They COULD call schema-aware
  // coercers; for now they just pass valid structures or null (triggering L3).
  // Future: wire tool schemas and coerce here.

  // L2: Safe defaults — none established yet; defer to telemetry.

  // L3: If still broken, handlers will validate and route through L3 feedback.
  // This function returns what we could fix.
  return {
    args: out,
    applied,
    recoverable: true,
  };
}

/**
 * L0: Lossless repairs. Safe on any arg, any type. Mutates `applied` in place.
 */
function applyL0(
  args: Record<string, unknown>,
  applied: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) {
      applied.push(`drop-null:${key}`);
      continue;
    }

    if (typeof value === "string") {
      const unlinked = unwrapAutoLink(value);

      if (unlinked !== value) {
        applied.push(`unwrap-autolink:${key}`);
        out[key] = unlinked;
        continue;
      }
    }

    out[key] = value;
  }

  return out;
}

const AUTO_LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

/**
 * `[notes.md](notes.md)` / `[x](http://x)` where the link text equals the URL
 * (ignoring an `http(s)://` prefix and whitespace) → the text. Anything else
 * (a real link with distinct text/url) is returned unchanged.
 */
function unwrapAutoLink(value: string): string {
  const match = AUTO_LINK.exec(value.trim());

  if (match === null) {
    return value;
  }

  const text = (match[1] ?? "").replace(/\s+/g, "");
  const url = (match[2] ?? "").replace(/^https?:\/\//, "").replace(/\s+/g, "");

  return text === url ? (match[1] ?? "").trim() : value;
}

/**
 * L1: Schema coercion — per-tool rules applied by handlers that know their
 * field types (via tool schema context). These helpers are called by toEdits,
 * toCreate, toRead, toRun when they detect a coercible mismatch.
 */

/** Coerce a string to an array if it's a stringified JSON array. */
export function coerceStringToArray(value: unknown): unknown[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Coerce a string to its typed value if it's stringified. */
export function coerceStringValue(
  value: unknown,
  expectedType: "number" | "boolean"
): number | boolean | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();

  if (expectedType === "number") {
    const n = Number(trimmed);

    return Number.isFinite(n) ? n : null;
  }

  // expectedType === "boolean"
  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  return null;
}

/** Strip markdown code fences and extra whitespace from a string. */
export function trimMarkdownFences(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  let s = value.trim();

  // `  ```path.ts```  ` → `path.ts`
  if (s.startsWith("```") && s.endsWith("```")) {
    s = s.slice(3, -3).trim();
  }

  return s;
}
