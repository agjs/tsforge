import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import configPrettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import importX from "eslint-plugin-import-x";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import stylistic from "@stylistic/eslint-plugin";

/*
 * Inherited from boringstack/apps/api: the general TypeScript quality rules
 * (type-safety, async correctness, strict-boolean, naming, no-enum, prettier).
 * The API-architectural plugins (elysia/drizzle/stripe/...) are intentionally
 * omitted — they police that app's domain, not ours. Every rule is `error`.
 */
export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.astro/**", "apps/**"],
  },
  {
    files: ["packages/**/*.ts"],
    extends: [
      pluginJs.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      configPrettier,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      prettier: pluginPrettier,
      sonarjs,
      unicorn,
      "import-x": importX,
      "eslint-comments": eslintComments,
      "@stylistic": stylistic,
    },
    rules: {
      "prettier/prettier": "error",

      /*
       * Complexity + duplication — the rules that catch concern-mixing and
       * copy-paste. Thresholds are generous now (the god-files exceed the
       * boringstack's 20/5) and ratchet down to 20/5 in the final phase once the
       * files are split. Ported from boringstack apps/api eslint.config.js.
       */
      // Cognitive-complexity ceiling at boringstack's 20. The loop coordinator
      // (runTask/settleGate) was decomposed into named helpers to hit it.
      "sonarjs/cognitive-complexity": ["error", 20],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicate-string": ["error", { threshold: 5 }],
      "sonarjs/no-useless-catch": "error",
      "sonarjs/prefer-immediate-return": "error",

      // Idiom hygiene (curated unicorn subset from boringstack).
      "unicorn/prefer-string-starts-ends-with": "error",
      "unicorn/prefer-includes": "error",
      "unicorn/prefer-ternary": "error",
      "unicorn/throw-new-error": "error",
      "unicorn/no-lonely-if": "error",
      "unicorn/error-message": "error",
      "unicorn/prefer-array-some": "error",
      "unicorn/prefer-array-find": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/no-instanceof-array": "error",

      // Import hygiene.
      "import-x/no-duplicates": "error",
      "import-x/no-self-import": "error",
      "import-x/no-useless-path-segments": "error",
      "import-x/first": "error",

      // Defense-in-depth: no inline rule suppressions — fix the code or the rule.
      "eslint-comments/no-use": ["error", { allow: [] }],

      // Hard bans — things an AI agent must never write.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],

      // Async correctness.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // Type-safety hygiene.
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
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
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Naming — boringstack identifier shape (I-prefixed interfaces).
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
        { selector: "typeAlias", format: ["PascalCase"] },
        { selector: "typeParameter", format: ["PascalCase"] },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow",
        },
        { selector: "function", format: ["camelCase", "PascalCase"] },
        { selector: ["objectLiteralProperty", "typeProperty"], format: null },
      ],

      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-console": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use 'as const' object literals instead of enums.",
        },
      ],
    },
  },
  {
    // Scripts are operational ENTRY POINTS, not throwaway — held to `src`
    // strictness (type-safety, no-duplicate-string, complexity). The ONLY
    // allowance is console output: printing results to stdout is their job.
    // (A relaxed no-duplicate-string here once hid an 11x-repeated model literal.)
    files: ["packages/**/scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Tests: the minimal, universally-justified ergonomic exceptions only —
    // mocks need `!`/`as`/unsafe access of untyped shapes, async wrappers don't
    // always await, and suites legitimately repeat fixture strings. Everything
    // else stays as strict as src.
    files: ["packages/**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": "off",
      "no-console": "off",
      // Suites repeat fixture/expected strings; complexity in a big table-driven
      // test isn't the same smell as in product code.
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/no-identical-functions": "off",
    },
  },
  {
    // Rule implementations and utilities in packages/core/src/rule-packs/
    // legitimately need AST-node property access that would trigger the strict
    // type-safety rules. ESLint rule implementations require direct access to
    // untyped AST shapes (e.g., checking node.object.name, node.property.name
    // without full type guards). This minimal override relaxes only the rules
    // genuinely needed for AST manipulation.
    files: ["packages/core/src/rule-packs/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    /*
     * MECHANICAL core↔adapter boundary (the law made enforceable, WS4). The generic core loop
     * — everything under `loop/**` EXCEPT the BoringStack adapter itself — must never import the
     * adapter (`loop/boringstack/**`). WS1–WS3 reclaimed the leaks (conventions, stack-adapter,
     * plan spine) by hand; this rule keeps them reclaimed: any future core-loop file that reaches
     * back into `loop/boringstack/**` fails `bun run validate`, not code review.
     *
     * The rule's SCOPE is the definition of "core loop": this config block applies to every
     * `.ts` under `loop/` except the `loop/boringstack/` subtree, so the exemptions fall out of the tree with no
     * hand-maintained allow-list — the composition roots that legitimately wire the adapter in
     * (`cli.ts`, `cli/**`), the scripts, and the tests all live OUTSIDE `loop/**` and are never
     * subject to it; the adapter's own intra-`boringstack` imports are excluded via `ignores`.
     * Enforced with `@typescript-eslint/no-restricted-imports` matching the SPECIFIER (see the
     * inline note on the rule below) — every way to reach the adapter from inside `loop/` is a
     * relative specifier that names the `boringstack/` segment (`../boringstack/x`,
     * `./boringstack/x`, `../../boringstack/x`), so a specifier glob catches them all with no
     * path resolver (the physical-path rule `import-x/no-restricted-paths` would need a TS
     * resolver that isn't installed).
     */
    files: ["packages/core/src/loop/**/*.ts"],
    ignores: ["packages/core/src/loop/boringstack/**"],
    rules: {
      // `@typescript-eslint/no-restricted-imports` (a superset of core no-restricted-imports that
      // ALSO catches `import type`) matches the import SPECIFIER — no path resolver needed. From
      // within `loop/`, the only way to reach the adapter is a relative specifier that names the
      // `boringstack/` path segment (`../boringstack/x`, `./boringstack/x`, `../../boringstack/x`),
      // so the two globs below (the bare dir index + anything under it) catch every form.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/boringstack", "**/boringstack/**"],
              message:
                "Core loop must not import the BoringStack adapter (loop/boringstack/**). Core stays stack-agnostic — inject the adapter behind its seam (IConventionProvider / IStackAdapter / IPlanSchema) and wire it at a composition root (cli.ts, cli/**, scripts/**).",
            },
          ],
        },
      ],
      // no-restricted-imports covers STATIC import/export declarations but NOT runtime module loads
      // — a dynamic `import("../boringstack/x")` (ImportExpression) or a `createRequire(...)(...)`
      // (CommonJS interop) — which would otherwise reach the adapter and bypass the boundary. Close
      // every form whose target path is a STATIC STRING somewhere in the AST, via selectors on the
      // loader argument: (1) any string Literal naming a boringstack segment ANYWHERE in an
      // import() argument (covers `import("../boringstack/x")`, a ternary, and
      // `import("../boringstack/" + n)`); (2) any template-literal quasi naming it (covers
      // `import(`../boringstack/x`)`); (3) an immediately-invoked `createRequire(...)("...boringstack...")`.
      // DOCUMENTED INHERENT LIMIT (not a gap to chase — the WS2 lesson: close what's statically
      // matchable, document the rest): a path assembled at RUNTIME is beyond static AST matching for
      // ANY lint rule — `import(runtimeVar)`, a segment-splitting concat `"../bor" + "ingstack/x"`
      // where no single node holds the segment, or a require function ALIASED to a variable first
      // (`const r = createRequire(u); r("../boringstack/x")`). None of these is how a known module is
      // ever loaded; they are adversarial, and this is a pure-ESM codebase with zero `createRequire`
      // use. NOTE: this whole rule REPLACES the base `no-restricted-syntax` (the enum ban) for loop
      // files — flat config overrides a rule wholesale per key — so the enum selector is re-included
      // here (and a test asserts it still fires in loop files).
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use 'as const' object literals instead of enums.",
        },
        {
          // Any boringstack string Literal ANYWHERE in a runtime-loader argument — a dynamic
          // `import(...)` OR an immediately-invoked `createRequire(...)(...)`. Descendant match, so
          // it covers the string, a `"../boringstack/" + n` concat, and a ternary arg uniformly for
          // BOTH loaders.
          selector:
            ':matches(ImportExpression, CallExpression[callee.callee.name="createRequire"]) Literal[value=/(^|\\u002F)boringstack($|\\u002F)/]',
          message:
            "Core loop must not import the BoringStack adapter (loop/boringstack/**), including via a dynamic import() or createRequire(...)(). Inject the adapter behind its seam and wire it at a composition root (cli.ts, cli/**, scripts/**).",
        },
        {
          // The templated form of either loader (`import(`../boringstack/x`)` /
          // `createRequire(u)(`../boringstack/x`)`).
          selector:
            ':matches(ImportExpression, CallExpression[callee.callee.name="createRequire"]) TemplateElement[value.cooked=/(^|\\u002F)boringstack($|\\u002F)/]',
          message:
            "Core loop must not import the BoringStack adapter (loop/boringstack/**), including via a templated dynamic import() or createRequire(...)(). Inject the adapter behind its seam and wire it at a composition root (cli.ts, cli/**, scripts/**).",
        },
      ],
    },
  }
);
