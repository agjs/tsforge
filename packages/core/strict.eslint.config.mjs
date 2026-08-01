// tsforge's BUNDLED strict-TypeScript config — the toolchain it brings to ANY
// project to enforce idiomatic strict TS on the model's output, regardless of
// what (if anything) the target repo has configured. Deliberately SYNTACTIC-ONLY
// rules (no type-aware rules / no `parserOptions.project`) so it runs on any .ts
// without the target's deps or a compiling tsconfig. The type-aware floor (tsc
// strict + noUncheckedIndexedAccess, no-unsafe-*) is layered separately when a
// tsconfig is available. This is what lifts the local model: the casts / `any` /
// `!` / over-annotation it habitually emits become errors it must fix.
//
// Stack-aware rule packs are loaded via TSFORGE_PACKS env var (comma-separated
// pack IDs), allowing the gate to inject stack-specific rules dynamically.
// Rule overrides are loaded via TSFORGE_RULE_OVERRIDES env var (JSON-encoded
// map of bare rule names to "error" | "warn" | "off"). Project CONVENTIONS
// (interface naming, enum policy) are loaded via TSFORGE_CONVENTIONS (JSON) and
// rebuild the naming-convention / no-restricted-syntax rule OPTIONS — the single
// source shared with the gate command, the write-time linter, and the prompts.
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";
import sonarjs from "eslint-plugin-sonarjs";

// Every TypeScript source extension the strict floor lints — including the ESM/CJS
// module variants `.mts`/`.cts`, which are TS and must get the same moat as `.ts`.
// Single source so the pack and base blocks below can't drift apart.
const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

// Load stack-aware packs if TSFORGE_PACKS env var is set
let packConfig = [];
const packIds = (process.env.TSFORGE_PACKS ?? "").split(",").filter(Boolean);
let ruleOverrides = {};

if (process.env.TSFORGE_RULE_OVERRIDES !== undefined) {
  try {
    ruleOverrides = JSON.parse(process.env.TSFORGE_RULE_OVERRIDES);
    if (typeof ruleOverrides !== "object" || ruleOverrides === null) {
      ruleOverrides = {};
    }
  } catch {
    // If parsing fails, silently ignore overrides
  }
}

if (packIds.length > 0) {
  try {
    const { buildPackEslintConfig } = await import("./src/rule-packs/index.ts");
    const { plugin, rules } = buildPackEslintConfig(packIds, ruleOverrides);
    packConfig = [
      {
        files: TS_FILES,
        plugins: { tsforge: plugin },
        rules,
      },
    ];
  } catch {
    // If pack loading fails, silently continue without them
  }
}

// The convention-managed rules. Default to tsforge's house style (I-prefix +
// enum ban) so a failed import NEVER silently drops the enum ban / naming rule;
// the builder then rebuilds them from TSFORGE_CONVENTIONS, and the override pass
// honors TSFORGE_RULE_OVERRIDES on the bundled rules (safety floor protected).
let conventionRules = {
  "@typescript-eslint/naming-convention": [
    "error",
    { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "TSEnumDeclaration",
      message: "Use 'as const' object literals instead of enums.",
    },
  ],
};
let applyBundledOverrides = (rules) => rules;

try {
  const conv = await import("./src/infer-rules/eslint-conventions.ts");
  const conventions = conv.parseConventionsEnv(process.env.TSFORGE_CONVENTIONS);
  conventionRules = conv.conventionRuleEntries(conventions, "core");
  applyBundledOverrides = (rules) =>
    conv.applyBundledOverrides(rules, ruleOverrides);
} catch {
  // Keep the hardcoded house-style defaults above.
}

// Bundled syntactic rules MINUS the two convention-managed ones (spliced below).
const bundledRules = {
  // Concern-mixing / copy-paste ceiling (syntactic — no type info needed).
  // cc <= 20 is the house rule tsforge holds ITSELF to (eslint.config.js); it
  // forces the model to decompose a sprawling function into named helpers
  // instead of one un-reviewable block. Not auto-fixable, so it surfaces as a
  // hand-fix error — the intended "split this up" signal. max-depth/max-params
  // are zero-dep ESLint-core complements.
  "sonarjs/cognitive-complexity": ["error", 20],
  "sonarjs/no-identical-functions": "error",
  "max-depth": ["error", 4],
  "max-params": ["error", 4],
  // The idioms the model habitually violates — all caught WITHOUT type info.
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "never" },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-inferrable-types": "error",
  "prefer-const": "error",
  "prefer-template": "error",
  "no-var": "error",
  // Blank-line discipline — the model rarely gets spacing right, so
  // eslint --fix + prettier make it free. Uses @stylistic (the rule's
  // maintained home; the core rule is deprecated and spams usedDeprecatedRules
  // into eslint's --format json gate output).
  "@stylistic/padding-line-between-statements": [
    "error",
    { blankLine: "always", prev: "import", next: "*" },
    { blankLine: "any", prev: "import", next: "import" },
    { blankLine: "always", prev: "*", next: "return" },
    { blankLine: "always", prev: "*", next: "throw" },
    { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
    {
      blankLine: "any",
      prev: ["const", "let", "var"],
      next: ["const", "let", "var"],
    },
    { blankLine: "always", prev: "block-like", next: "*" },
    { blankLine: "always", prev: "*", next: "block-like" },
  ],
  eqeqeq: ["error", "always"],
  curly: ["error", "all"],
};

const rules = applyBundledOverrides({ ...bundledRules, ...conventionRules });

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: TS_FILES,
    languageOptions: { parser: tseslint.parser },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "@stylistic": stylistic,
      sonarjs,
    },
    rules,
  },
  ...packConfig
);
