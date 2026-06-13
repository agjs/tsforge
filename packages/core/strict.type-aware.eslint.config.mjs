// Optional type-aware ESLint overlay — enabled only when the target has a
// compiling tsconfig (see detect-gate.ts). Adds async correctness rules that
// require parserOptions.project; kept separate from strict.eslint.config.mjs
// so the syntactic gate still runs on any .ts file without type info.
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
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
    },
  }
);
