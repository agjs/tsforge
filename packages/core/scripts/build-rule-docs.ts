// Offline cache builder: fetch typescript-eslint rule docs from their own
// source `.mdx`, parse the ❌/✅ examples deterministically, and write the
// committed cache the repair loop reads. Run when rules change:
//   bun run packages/core/scripts/build-rule-docs.ts
import { join } from "node:path";
import { parseRuleMdx, type IRuleDoc } from "../src/loop/feedback/rule-docs";

const BASE =
  "https://raw.githubusercontent.com/typescript-eslint/typescript-eslint/main/packages/eslint-plugin/docs/rules";

// The strict-mode rules that actually fire on TypeScript — the ones a repair
// loop hits. Curated entries in rule-docs.ts override these where they exist.
const RULES = [
  "no-explicit-any",
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-call",
  "no-unsafe-member-access",
  "no-unsafe-return",
  "no-non-null-assertion",
  "restrict-plus-operands",
  "restrict-template-expressions",
  "strict-boolean-expressions",
  "no-floating-promises",
  "no-misused-promises",
  "await-thenable",
  "no-for-in-array",
  "prefer-nullish-coalescing",
  "prefer-optional-chain",
  "no-unnecessary-condition",
  "no-unnecessary-type-assertion",
  "switch-exhaustiveness-check",
  "consistent-type-assertions",
  "no-base-to-string",
  "require-await",
  "no-confusing-void-expression",
  "no-redundant-type-constituents",
  "prefer-reduce-type-parameter",
];

const out: Record<string, IRuleDoc> = {};
let ok = 0;
let missed = 0;

for (const rule of RULES) {
  const res = await fetch(`${BASE}/${rule}.mdx`);

  if (!res.ok) {
    process.stdout.write(`  miss ${rule} (HTTP ${res.status})\n`);
    missed += 1;
    continue;
  }

  const doc = parseRuleMdx(await res.text());

  if (doc === null) {
    process.stdout.write(`  miss ${rule} (unparseable)\n`);
    missed += 1;
    continue;
  }

  out[`@typescript-eslint/${rule}`] = doc;
  ok += 1;
}

const path = join(
  import.meta.dir,
  "..",
  "src",
  "loop",
  "rule-docs.generated.json"
);

await Bun.write(path, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`\nwrote ${ok} rules (${missed} missed) → ${path}\n`);
