// tsforge's bundled strict config for WEB stacks (React/Vue/Svelte via Vite).
// Identical to strict.eslint.config.mjs EXCEPT it drops the `I`-prefix interface
// naming rule: the React/TS ecosystem names interfaces `ButtonProps` (PascalCase,
// often `Props`-suffixed), NOT `IButtonProps`, and library module augmentations
// dictate the name outright (e.g. TanStack Router's `interface Register`) — so an
// `I`-prefix mandate fights the whole ecosystem here. Every other strict rule
// (no `as`/`any`/`!`, prefer-const/template, eqeqeq, curly, no-enum) is kept.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // NOTE: we do NOT use `consistent-type-assertions: never` here — that also
      // bans `as const`, which is idiomatic and the cleanest escape for typed
      // literal/tuple data (and it makes a fixed array a tuple, so literal-index
      // access is defined, not `T | undefined`). Instead we ban only the
      // value-changing forms (`x as Foo`, `<Foo>x`) via AST selectors below.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use 'as const' object literals instead of enums.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name!='const']",
          message:
            "No `as` type casts — type it properly (annotate, narrow, or guard). `as const` is allowed.",
        },
        {
          selector: "TSTypeAssertion",
          message:
            "No angle-bracket type assertions — type it properly. `as const` is allowed.",
        },
      ],
    },
  }
);
