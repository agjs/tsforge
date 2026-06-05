/**
 * Generic, schema-agnostic repair of malformed tool inputs from open models.
 *
 * The harness is where we mediate between the model's output distribution and a
 * strict tool contract — a strict schema filters noise but also rejects
 * RECOVERABLE noise that big commercial models absorb invisibly. As tsforge
 * grows past its 4 starter tools, this is the one place that keeps every new
 * tool forgiving in the same way (CommandCode's "open model bad at tool calling
 * is a harness problem" writeup — the failure modes are a small finite set).
 *
 * CRITICAL ordering: VALIDATE THEN REPAIR, never preprocess-then-validate. We
 * only touch input the tool's own parser has ALREADY rejected — so a valid
 * input (e.g. file `content` that happens to be JSON-shaped) is never rewritten.
 * The parser is the prior; we spend repair budget only where it actually
 * disagreed.
 *
 * Catalogue (extend as per-tool telemetry surfaces new modes):
 *  - drop `null`/`undefined` values — model sends `null` for an optional field
 *    instead of omitting it.
 *  - unwrap a degenerate markdown auto-link on a string — `[notes.md](notes.md)`
 *    → `notes.md`. The conversational post-training distribution (rewarded for
 *    auto-linking) leaking through the tool boundary onto path fields. Only the
 *    link-text == url-without-protocol case is unwrapped; real links like
 *    `[click](https://x.com)` pass through untouched.
 *
 * Deferred until tools declare field types (no schema layer yet): stringified
 * arrays (`'["a","b"]'` → `["a","b"]`) and bare-string-wrap (`"a"` → `["a"]`),
 * because blindly parsing JSON-shaped strings would corrupt free-text fields
 * (`content`, `oldString`, `command`). Add them per array-field when needed.
 */
export function repairArgs(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  applied: string[];
} {
  const applied: string[] = [];
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

  return { args: out, applied };
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
