import type { ErrorSet } from "../validate/errors";
import generatedJson from "./rule-docs.generated.json";

export interface IRuleDoc {
  /** One-line statement of what the rule requires. */
  what: string;
  /** A minimal example that VIOLATES the rule. */
  bad: string;
  /** The corrected version that satisfies it. */
  good: string;
}

/**
 * Auto-fetched docs (eslint/typescript-eslint rules) built offline by
 * `scripts/build-rule-docs.ts` from the rules' own source. Curated entries
 * below take precedence; this fills coverage for everything else.
 */
const GENERATED: Record<string, IRuleDoc> = generatedJson;

/**
 * Curated documentation for the rules our gate actually enforces — each with a
 * before/after, the way a human resolves a lint/type error. Keyed by the exact
 * `rule` the validators emit: TS diagnostic codes (`TS2532`) and eslint rule
 * ids (`@typescript-eslint/...`). Surfacing the rule's own bad→good next to the
 * failure beats making the model re-derive the fix from scratch.
 */
const RULE_DOCS: Record<string, IRuleDoc> = {
  TS2532: {
    what: "Indexed access is `T | undefined` (noUncheckedIndexedAccess). Bind and guard before use; never `!`.",
    bad: "total += arr[i];",
    good: "const x = arr[i]; if (x === undefined) { continue; } total += x;",
  },
  TS18048: {
    what: "Value is possibly `undefined`. Guard it before use.",
    bad: "return obj.maybe.length;",
    good: "const v = obj.maybe; if (v === undefined) { return 0; } return v.length;",
  },
  TS2322: {
    what: "Type is not assignable to the target type — fix the value or the annotation, don't widen to `any`.",
    bad: "const n: number = readLine();",
    good: "const n: number = Number(readLine());",
  },
  "@typescript-eslint/no-unsafe-return": {
    what: "Don't return a value typed `any` — narrow it to a real type before returning.",
    bad: "function f() { return JSON.parse(s); }",
    good: "const v: unknown = JSON.parse(s); if (typeof v === 'number') { return v; } return 0;",
  },
  "@typescript-eslint/no-unsafe-assignment": {
    what: "Don't assign an `any` to a typed target — type the source.",
    bad: "const xs = data.map((a, b) => a + b);",
    good: "const xs: number[] = data.map((a: number, b: number) => a + b);",
  },
  "@typescript-eslint/no-unsafe-member-access": {
    what: "Don't access members off an `any`. Narrow to a known type first.",
    bad: "return res.body.id;",
    good: "const body: unknown = res.body; if (isRecord(body)) { return body.id; }",
  },
  "@typescript-eslint/restrict-plus-operands": {
    what: "`+` operands must each be number or string — an `any`/`undefined` is leaking in; type/guard it.",
    bad: "const sum = a + b; // a or b is any | undefined",
    good: "const sum: number = (a ?? 0) + (b ?? 0); // with a, b: number",
  },
  "@typescript-eslint/no-explicit-any": {
    what: "No `any`. Use a real type, or `unknown` + a type guard.",
    bad: "function parse(x: any) {}",
    good: "function parse(x: unknown) { if (typeof x === 'string') { /* ... */ } }",
  },
  "@typescript-eslint/no-non-null-assertion": {
    what: "No `!`. Guard the value instead.",
    bad: "const first = arr[0]!;",
    good: "const first = arr[0]; if (first === undefined) { return; }",
  },
  "@typescript-eslint/consistent-type-assertions": {
    what: "No `as` casts. Use a type guard or `satisfies`.",
    bad: "const u = json as IUser;",
    good: "if (isUser(json)) { const u = json; /* narrowed */ }",
  },
  "@typescript-eslint/strict-boolean-expressions": {
    what: "Conditions must be explicit booleans — no truthy strings/numbers/nullables.",
    bad: "if (name) {}",
    good: "if (name !== undefined && name.length > 0) {}",
  },
  "@typescript-eslint/naming-convention": {
    what: "Interfaces are PascalCase with an `I` prefix.",
    bad: "interface User {}",
    good: "interface IUser {}",
  },
  "@typescript-eslint/no-floating-promises": {
    what: "A promise must be awaited or explicitly voided.",
    bad: "doAsync();",
    good: "await doAsync(); // or: void doAsync();",
  },
  "prefer-const": {
    what: "Use `const` for never-reassigned bindings.",
    bad: "let x = 1;",
    good: "const x = 1;",
  },
  eqeqeq: {
    what: "Use `===`/`!==`.",
    bad: "if (a == b) {}",
    good: "if (a === b) {}",
  },
};

/**
 * Strict-TypeScript idiom traps: valid JavaScript the model habitually writes
 * that trips the gate in a way the rule MESSAGE alone doesn't explain — the
 * failure fires at the use-site, not where the bad value was created. Matched
 * against the editable file's SOURCE (not just the errored line), and gated on
 * the error set looking like this trap's failure, so the hint is precise and
 * never fires spuriously on a clean run.
 *
 * Seeded from a real, repeated `money` failure: `new Array(n).fill(x)` is typed
 * `any[]` under strict, so the model fixed it, reintroduced it, and fixed it
 * again across separate turns.
 */
interface IIdiomTrap {
  /** Pattern in the editable source that signals the trap is present. */
  inSource: RegExp;
  /** Tested against each error's `rule + message`; the hint only shows on a match. */
  relevant: RegExp;
  /** The targeted fix, shown when both conditions hold. */
  hint: string;
}

const IDIOM_TRAPS: readonly IIdiomTrap[] = [
  {
    inSource: /new\s+Array\s*\([^)]*\)\s*\.fill\(/,
    relevant: /unsafe|no-explicit-any|\bany\b/i,
    hint: "`new Array(n).fill(x)` is typed `any[]` under strict TypeScript, so every element read off it is `any`. Use `Array.from({ length: n }, () => x)` — it's typed `T[]`.",
  },
];

/**
 * Idiom hints for traps whose pattern appears in the given source AND whose
 * signature matches the current errors. `sources` are the editable files'
 * contents; `errors` are the gate failures.
 */
export function idiomHints(
  sources: readonly string[],
  errors: ErrorSet
): string {
  const errText = errors.map((e) => `${e.rule ?? ""} ${e.message}`).join("\n");
  const hints = new Set<string>();

  for (const trap of IDIOM_TRAPS) {
    if (!trap.relevant.test(errText)) {
      continue;
    }

    if (sources.some((s) => trap.inSource.test(s))) {
      hints.add(trap.hint);
    }
  }

  return [...hints].map((h) => `- ${h}`).join("\n");
}

/**
 * Pull rule guidance straight from raw command output (tsc text, `eslint
 * --format json`, plain eslint). This is what lets the docs reach the model
 * when IT runs the gate via the `run` tool — otherwise it only sees raw errors
 * and fixes them blind across many rounds.
 */
export function ruleHelpFromOutput(output: string): string {
  const ids = new Set<string>();

  for (const m of output.matchAll(/TS\d+/g)) {
    ids.add(m[0]);
  }

  for (const m of output.matchAll(/"ruleId"\s*:\s*"([^"]+)"/g)) {
    if (m[1] !== undefined) {
      ids.add(m[1]);
    }
  }

  for (const m of output.matchAll(/@typescript-eslint\/[a-z-]+/g)) {
    ids.add(m[0]);
  }

  const errors = [...ids].map((rule) => ({ key: rule, rule, message: "" }));

  return ruleHelp(errors);
}

/** Format the rule docs for whichever rules appear in the current error set. */
export function ruleHelp(errors: ErrorSet): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const e of errors) {
    if (e.rule === undefined || seen.has(e.rule)) {
      continue;
    }

    const doc = RULE_DOCS[e.rule] ?? GENERATED[e.rule];

    if (doc === undefined) {
      continue;
    }

    seen.add(e.rule);
    blocks.push(`${e.rule}: ${doc.what}\n  ✗ ${doc.bad}\n  ✓ ${doc.good}`);
  }

  return blocks.join("\n");
}

/**
 * Parse a typescript-eslint rule's source `.mdx` into a doc. The format is
 * regular: a frontmatter `description:` and `<TabItem value="❌ Incorrect">` /
 * `"✅ Correct"` sections each followed by a fenced ```ts block. Used offline by
 * the cache builder. Returns null if the expected sections aren't found.
 */
export function parseRuleMdx(mdx: string): IRuleDoc | null {
  const desc = /^description:\s*['"]([\s\S]+?)['"]\s*$/m.exec(mdx);
  const bad = firstTsBlock(mdx, "❌ Incorrect");
  const good = firstTsBlock(mdx, "✅ Correct");

  if (bad === null || good === null) {
    return null;
  }

  return {
    what: desc?.[1] ?? "",
    bad: cap(bad),
    good: cap(good),
  };
}

function firstTsBlock(mdx: string, marker: string): string | null {
  const at = mdx.indexOf(marker);

  if (at === -1) {
    return null;
  }

  const block = /```ts\n([\s\S]*?)```/.exec(mdx.slice(at));

  return block?.[1]?.trimEnd() ?? null;
}

/** Keep examples prompt-lean — first ~8 lines, capped. */
function cap(code: string): string {
  const lines = code.split("\n").slice(0, 8).join("\n");

  return lines.length > 360 ? `${lines.slice(0, 360)}…` : lines;
}
