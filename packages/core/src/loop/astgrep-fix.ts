import { join } from "node:path";
import { readProcessOutput } from "../lib/fs";

/**
 * Deterministic, SAFE strict-TS idiom rewrites via ast-grep (structural, not
 * regex — it won't match inside strings/comments, and it understands the AST).
 * This is the "tsFixAll, but for idioms": mechanical quality fixes the model
 * shouldn't burn turns on. The `tsc -p` gate stays the authority — a rewrite
 * that broke anything would fail it.
 *
 * ONLY semantics-preserving rewrites belong here. `new Array(n).fill(x)` →
 * `Array.from({length:n},()=>x)` is safe (same array, but typed `T[]` instead of
 * `any[]`, which is the whole point). Loop restructures (bind-and-guard →
 * `.entries()`) are NOT safe blind codemods — those stay as guidance.
 */
interface IRewrite {
  pattern: string;
  rewrite: string;
  note: string;
}

const SAFE_REWRITES: readonly IRewrite[] = [
  {
    pattern: "new Array($N).fill($X)",
    rewrite: "Array.from({ length: $N }, () => $X)",
    note: "new Array().fill() is any[] under strict; Array.from is typed",
  },
];

/**
 * Drop a redundant type annotation on a `const` whose initializer already makes
 * the type obvious to inference — the over-annotation a reviewer flags but no
 * stock eslint rule catches (`no-inferrable-types` fires only on LITERAL
 * initializers, never on calls/expressions). Structural, so it can't misfire on
 * strings/comments. The `constraints` exclude the cases where dropping the
 * annotation would CHANGE the inferred type: an empty/array/object literal
 * (`number[] = []` infers `never[]`), `null`, or a function/arrow (loses its
 * contextual parameter types under strict). Even so this is only HALF the
 * safety — the caller re-runs the full gate and reverts the file if anything
 * regressed, so an unsafe drop we didn't foresee can never ship.
 */
const DROP_ANNOTATION_RULE = `
id: drop-redundant-annotation
language: typescript
rule:
  pattern: 'const $A: $T = $B'
constraints:
  B:
    not:
      any:
        - { kind: array }
        - { kind: object }
        - { kind: 'null' }
        - { kind: arrow_function }
        - { kind: function_expression }
fix: 'const $A = $B'
`;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const AST_GREP = join(REPO_ROOT, "node_modules", ".bin", "ast-grep");

async function astGrep(
  args: string[]
): Promise<{ stdout: string; ok: boolean }> {
  const proc = Bun.spawn([AST_GREP, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const { stdout } = await readProcessOutput(proc.stdout, proc.stderr);
  const code = await proc.exited;

  return { stdout, ok: code === 0 };
}

/**
 * Apply the safe idiom rewrites to `absFile` in place. Returns how many matches
 * were rewritten. No-ops (returns 0) if ast-grep isn't available, so it can
 * never break the loop — the gate re-validates regardless.
 */
export async function astGrepFix(absFile: string): Promise<number> {
  if (!(await Bun.file(AST_GREP).exists())) {
    return 0;
  }

  let applied = 0;

  for (const r of SAFE_REWRITES) {
    // Count matches first (JSON), then apply — so we can report an exact count.
    const found = await astGrep([
      "run",
      "-p",
      r.pattern,
      "-l",
      "ts",
      "--json",
      absFile,
    ]);

    if (!found.ok) {
      continue;
    }

    let matches = 0;

    try {
      const parsed: unknown = JSON.parse(found.stdout);

      matches = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      // non-JSON output → leave matches at 0
    }

    if (matches === 0) {
      continue;
    }

    const done = await astGrep([
      "run",
      "-p",
      r.pattern,
      "--rewrite",
      r.rewrite,
      "-l",
      "ts",
      "--update-all",
      absFile,
    ]);

    if (done.ok) {
      applied += matches;
    }
  }

  return applied;
}

/**
 * Strip redundant `const` type annotations in `absFile` (see DROP_ANNOTATION_RULE).
 * Counts matches first (constraint-filtered), then applies, returning the number
 * rewritten. No-ops to 0 if ast-grep is absent. NOT verified here — the caller
 * MUST re-gate and revert on regression; this only performs the rewrite.
 */
export async function dropRedundantAnnotations(
  absFile: string
): Promise<number> {
  if (!(await Bun.file(AST_GREP).exists())) {
    return 0;
  }

  const found = await astGrep([
    "scan",
    "--inline-rules",
    DROP_ANNOTATION_RULE,
    "--json=compact",
    absFile,
  ]);

  if (!found.ok) {
    return 0;
  }

  let matches: number;

  try {
    const parsed: unknown = JSON.parse(found.stdout);

    matches = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }

  if (matches === 0) {
    return 0;
  }

  const done = await astGrep([
    "scan",
    "--inline-rules",
    DROP_ANNOTATION_RULE,
    "--update-all",
    absFile,
  ]);

  return done.ok ? matches : 0;
}
