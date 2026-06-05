import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import configPrettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";

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
    },
    rules: {
      "prettier/prettier": "error",

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
      "padding-line-between-statements": [
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
    // Tests + scripts: relax the rules that fight legitimate test/CLI patterns.
    files: ["packages/**/tests/**/*.ts", "packages/**/scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": "off",
      "no-console": "off",
    },
  }
);
