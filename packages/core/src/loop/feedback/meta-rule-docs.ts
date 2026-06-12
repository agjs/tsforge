/**
 * Documentation for meta-rules: project structure and config guardrails.
 * Each rule is keyed by its ID and includes a one-sentence explanation of the fix.
 */

export const META_RULE_DOCS: Record<string, string> = {
  // Supply chain
  "package-exact-deps":
    "Use exact versions in dependencies and devDependencies (no ^, ~, or ranges); only peerDependencies should use ranges.",

  "no-overlapping-libs":
    "Remove duplicate or conflicting library versions from the dependency tree; only one canonical version per library is allowed.",

  // Source text
  "no-eslint-disable-comments":
    "Remove `// eslint-disable` comments — they hide warnings. Fix the underlying violation or refactor the code.",

  "no-ts-suppressions":
    "Remove `// @ts-ignore` and `// @ts-expect-error` comments. Use proper type guards or narrowing instead of suppressing type errors.",

  // Config
  "tsconfig-paths-exist":
    "Verify that all paths defined in tsconfig.json point to existing files or directories; remove non-existent paths.",

  "tsconfig-strict":
    "Enable all strict mode flags in tsconfig.json (strict: true or all strict flags individually).",

  // Testing
  "test-sibling-required":
    "Add a test file for each source file; follow naming conventions (foo.ts → foo.test.ts or foo.spec.ts).",

  // CI
  "workflow-actions-pinned":
    "Pin GitHub Actions to specific versions in .github/workflows/*.yml (e.g., `actions/checkout@v4`, not `@main`).",

  "workflow-runner-pinned":
    "Specify an exact runner version in GitHub Actions workflows (e.g., `ubuntu-22.04`, not `ubuntu-latest`).",

  "workflow-timeout-required":
    "Add a timeout-minutes setting to each GitHub Actions job to prevent hanging workflows.",
};
