// tsforge's bundled strict config for WEB stacks (React/Vue/Svelte via Vite).
// Like strict.eslint.config.mjs, it ENFORCES `I`-prefixed interfaces (project
// house style — `IIssue`, `IButtonProps`), with ONE exemption: library module-
// augmentation interfaces whose name the library dictates and you cannot rename
// (e.g. TanStack Router's `interface Register`). Differs from the core config in
// one other way: it allows `as const` (banning only value-changing `as`/`<Foo>`
// via AST selectors), since `as const` is idiomatic for typed literal registries.
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
      // I-prefixed interfaces (house style), EXCEPT library-mandated augmentation
      // names you cannot rename (TanStack Router's `interface Register`).
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "interface",
          format: ["PascalCase"],
          prefix: ["I"],
          filter: { regex: "^(Register)$", match: false },
        },
      ],
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
