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
    files: [
      "packages/core/src/rule-packs/**/*.ts",
      "!packages/core/tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  }
);
