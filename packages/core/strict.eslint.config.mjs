// tsforge's BUNDLED strict-TypeScript config — the toolchain it brings to ANY
// project to enforce idiomatic strict TS on the model's output, regardless of
// what (if anything) the target repo has configured. Deliberately SYNTACTIC-ONLY
// rules (no type-aware rules / no `parserOptions.project`) so it runs on any .ts
// without the target's deps or a compiling tsconfig. The type-aware floor (tsc
// strict + noUncheckedIndexedAccess, no-unsafe-*) is layered separately when a
// tsconfig is available. This is what lifts the local model: the casts / `any` /
// `!` / over-annotation it habitually emits become errors it must fix.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // The idioms the model habitually violates — all caught WITHOUT type info.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
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
      ],
    },
  }
);
