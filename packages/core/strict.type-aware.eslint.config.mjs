// Optional type-aware ESLint overlay — enabled only when the target has a
// compiling tsconfig (see detect-gate.ts). These rules need full type info
// (parserOptions.project) and are kept separate from strict.eslint.config.mjs so
// the syntactic gate still runs on any .ts file without type info.
//
// Two jobs:
//   1. Async correctness — floating/misused promises (a dropped `await` is silent
//      data loss / unhandled rejection).
//   2. IMPLICIT-`any` containment — the `no-unsafe-*` family. `no-explicit-any`
//      (in the syntactic config) bans the literal `any` token, but it CANNOT see
//      `any` that leaks in from an untyped boundary: `JSON.parse(s)`, `await
//      res.json()`, an untyped dependency. `tsc --strict` propagates that `any`
//      silently. These rules are the only thing that catches it — they make the
//      generated-code gate enforce what tsforge already enforces on its OWN source
//      via strictTypeChecked. Curated to the HIGH-SIGNAL, low-thrash subset;
//      narrative rules (strict-boolean-expressions, no-unnecessary-condition,
//      restrict-template-expressions) are deliberately left off until a sweep
//      shows they don't thrash the local model.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Async correctness.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      "@typescript-eslint/await-thenable": "error",

      // Implicit-`any` containment: stop untyped boundary data from flowing
      // through the program unchecked.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Cheap, high-signal correctness rules that need type info.
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-plus-operands": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  }
);
