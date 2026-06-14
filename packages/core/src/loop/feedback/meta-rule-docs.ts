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

  "fastify-security-plugins":
    "Add @fastify/helmet, @fastify/cors, and @fastify/rate-limit when using fastify in production.",

  "lockfile-required":
    "Commit the lockfile for your package manager (package-lock.json, yarn.lock, pnpm-lock.yaml, or bun.lockb) and keep it in sync with package.json.",

  "single-package-manager":
    "Remove extra lockfiles — use one package manager and delete lockfiles from other tools.",

  "package-manager-field-required":
    'Add a "packageManager" field to package.json (e.g. "bun@1.3.14") so installs are reproducible across environments.',

  "no-git-or-tarball-dependencies":
    "Replace git+, git:, or HTTP tarball dependency URLs with registry versions from npm.",

  "dependency-overrides-require-comment":
    "Add a comment next to overrides/resolutions in package.json explaining why each override is needed.",

  "production-must-not-use-drizzle-push":
    "Replace `drizzle-kit push` in scripts and CI with checked-in SQL migrations and `drizzle-kit migrate`.",

  "migrations-must-be-checked-in":
    "Add a drizzle/ or migrations/ folder with generated SQL migration files when using Drizzle ORM.",

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

  "tsconfig-recommended-flags":
    "Enable useUnknownInCatchVariables, erasableSyntaxOnly, exactOptionalPropertyTypes, verbatimModuleSyntax, and noPropertyAccessFromIndexSignature in tsconfig.json compilerOptions.",

  "next-proxy-over-middleware":
    "Migrate middleware.ts to proxy.ts for Next.js 16 early request interception.",

  "next-instrumentation-present":
    "Add instrumentation.ts with registerOTel for OpenTelemetry tracing in Next.js apps.",

  "next-image-remote-patterns-no-wildcards":
    "Remove `**` hostname wildcards from next.config remotePatterns — allowlist specific image hostnames.",

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

  "workflow-permissions-explicit":
    "Add a top-level permissions: block or job-level permissions to every GitHub Actions workflow.",

  "workflow-permissions-least-privilege":
    "Avoid workflow-level contents: write or id-token: write — scope write permissions to the job that needs them.",

  "no-pull-request-target-untrusted-checkout":
    "Do not combine pull_request_target with checkout of the PR head ref — use pull_request or checkout the base ref.",

  "no-github-context-in-shell":
    "Pass github.event values through env: instead of interpolating them directly in run: shell scripts.",

  // Container
  "dockerfile-base-image-pinned":
    "Pin every Dockerfile FROM to an explicit non-latest tag (e.g. node:24.3.0-bookworm) or a @sha256: digest; build-stage references and scratch are exempt.",

  "dockerfile-non-root-user":
    "Add a non-root USER instruction (after the install steps) so the container process does not run as root.",

  "dockerfile-no-secrets-in-env-arg":
    "Do not assign secret-looking ENV/ARG literals (names ending in _KEY/_TOKEN/_SECRET/_PASSWORD) — they bake into image layers; inject them at runtime via --env-file, a secret manager, or a BuildKit --secret mount.",
};
