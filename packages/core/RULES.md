# Rules and Meta-Rules Catalog

Rules are grouped by **adoption tier**. Use `profile` in `tsforge.config.json` to control which tiers are active by default.

## Profiles

- **recommended**: Safety + framework packs from stack detection; architecture opinions off by default.
- **strict**: Recommended plus CI/supply-chain meta-rules at error and type-aware async rules.
- **security**: Recommended plus runtime-boundaries and experimental authorization heuristics.
- **opinionated**: Full house-style architecture rules including component folder structure.

## Rule Packs by Tier

### Tier: safety

- **drizzle/update-delete-account-scoped-must-filter-scope** [ERROR]: Require Drizzle `.update()` / `.delete()` against account-scoped tables to filter by a scope column in `.where()`.
- **drizzle/update-delete-must-have-where** [ERROR]: Require every Drizzle `.update()` and `.delete()` call to include a `.where()` clause — unscoped writes affect every row.
- **jwt-cookies/auth-cookie-must-set-maxage-or-expires** [WARN]: Auth-cookie writes should set `maxAge` or `expires` so session cookies do not live forever by default.
- **jwt-cookies/auth-cookie-must-set-samesite** [ERROR]: Auth-cookie writes must set `sameSite` (`strict` or `lax`) — missing SameSite allows cross-site cookie delivery.
- **jwt-cookies/jwt-must-verify-not-decode** [ERROR]: Disallow `jwt.decode` / `decodeJwt` — decoding without verification accepts forged tokens. Use `jwt.verify` or `jwtVerify` instead.
- **nextjs/no-secret-props-to-client** [WARN]: Warn when Server Components pass secret-looking props to JSX — values may cross the client boundary.
- **runtime-boundaries/no-prototype-polluting-merge** [ERROR]: Disallow merging request body/query/params into objects — enables prototype pollution.
- **runtime-boundaries/no-user-controlled-fetch-url** [ERROR]: Disallow fetch/axios requests whose ORIGIN is not fixed at author time — a runtime-controlled host enables SSRF.
- **runtime-boundaries/no-user-controlled-redirect** [ERROR]: Disallow redirects to non-literal URLs — user-controlled redirects enable open redirects.
- **runtime-boundaries/upload-must-set-limits** [WARN]: Multipart upload handlers should declare `limits` or `maxFileSize` to bound request size.
- **runtime-boundaries/webhook-must-verify-signature-before-parse** [WARN]: Webhook handlers must verify signatures before calling `.json()` on the request body.
- **security/catch-must-handle** [ERROR]: Catch blocks must log, rethrow, or propagate errors — not silently return empty defaults on failure.
- **security/no-auth-token-in-storage** [ERROR]: Disallow storing or reading auth tokens from localStorage/sessionStorage — use httpOnly cookies instead.
- **security/no-child-process-exec** [ERROR]: Disallow child_process.exec/execSync — they run commands in a shell. Use execFile or spawn without shell instead.
- **security/no-dynamic-regexp** [ERROR]: Disallow new RegExp(non-literal) — dynamic patterns enable ReDoS. Use string-literal regexes or a safe engine like re2.
- **security/no-inner-html-assignment** [ERROR]: Disallow assigning to innerHTML — use textContent/innerText or sanitize with DOMPurify before injecting HTML.
- **security/no-spawn-with-shell** [ERROR]: Disallow child_process.spawn/spawnSync with shell: true — shell execution enables command injection.
- **typescript-core/fetch-must-check-ok** [ERROR]: HTTP fetch responses must check `.ok` or status before calling `.json()`.
- **typescript-core/json-parse-must-validate** [ERROR]: Disallow bare JSON.parse on untrusted input — validate through a schema library.
- **typescript-core/no-self-import** [ERROR]: Disallow a module importing or re-exporting from itself (a circular self-reference whose binding doesn't exist).
- **typescript-core/no-unsafe-boundary-cast** [ERROR]: Disallow type assertions immediately after parsing untrusted boundary input.

### Tier: framework

- **ai-sdk/no-api-key-in-client** [ERROR]: Disallow constructing an AI provider client in a client component — it leaks the API key into the browser bundle. Call the model from a server route/action.
- **ai-sdk/no-user-input-in-system-prompt** [WARN]: Warn when a system prompt is built by string interpolation/concatenation — splicing request data into the system role enables prompt injection. Keep the system prompt constant; pass user input as a user message.
- **ai-sdk/require-completion-token-limit** [ERROR]: Require a token limit (maxTokens / max_tokens) on AI completion calls to bound runaway cost and latency.
- **bullmq/job-name-must-be-constant** [WARN]: Disallow string-literal job names in `<queue>.add(name, ...)` calls — use a constant identifier so all consumers share one source of truth.
- **bullmq/job-options-must-set-attempts** [ERROR]: Every `<queue>.add(...)` must configure `attempts` (per-call or via `defaultJobOptions`); when `attempts > 1`, also require `backoff`.
- **bullmq/no-blocking-concurrency-zero** [ERROR]: Disallow `new Worker(name, processor, { concurrency: <numericLiteral ≤ 0> })` — non-positive concurrency blocks job processing.
- **bullmq/queue-options-must-set-removeoncomplete** [ERROR]: Every `<queue>.add(...)` must configure `removeOnComplete` (per-call or via `defaultJobOptions`) so completed jobs don't accumulate in Redis.
- **bullmq/queue-options-must-set-removeonfail** [ERROR]: Every `<queue>.add(...)` must configure `removeOnFail` (per-call or via `defaultJobOptions`) so failed jobs don't accumulate in Redis.
- **bullmq/worker-must-implement-close** [ERROR]: Classes that own a `new Worker(...)` instance must declare a close-equivalent method for graceful shutdown.
- **bullmq/worker-must-listen-failed** [ERROR]: Every `new Worker(...)` must register listeners for required events (default `failed`) — BullMQ failures are silent unless explicitly subscribed.
- **code-flow/no-bare-date-now** [ERROR]: Disallow direct calls to non-deterministic time/random sources (`Date.now()`, `new Date()`, `Date()`, `Math.random()`) outside an allowlisted set of utility paths. Determinism is required for snapshot tests, workflow replays, and time-travel debugging — every consumer should route through a typed util that can be faked in tests.
- **code-flow/no-template-trim-empty-ternary** [ERROR]: Disallow inline `<template>.trim() === '' ? fallback : <template>.trim()` patterns. Extract to a named utility.
- **code-flow/no-throw-literal** [ERROR]: Disallow throwing primitive literals (strings, numbers) — throw Error instances so error handlers can propagate status and stack traces correctly.
- **drizzle/account-scoped-tables-require-where** [ERROR]: Require every Drizzle query against a configured account-scoped table to filter by a scope column (accountId by default).
- **drizzle/no-nested-db-transaction** [ERROR]: Forbid invoking the outer db's `.transaction(...)` method inside a transaction callback — use the callback's `tx` parameter instead to avoid deadlocks.
- **drizzle/no-raw-sql-outside-allowlist** [ERROR]: Disallow drizzle-orm `sql` tagged template literals outside an allowlist of files (migrations, raw queries).
- **drizzle/relations-must-cover-fks** [ERROR]: Every Drizzle table that declares a foreignKey(...) must be covered by a relations(...) call. Searches sibling `relations.ts` files by default.
- **drizzle/schema-files-must-not-import-driver** [ERROR]: Disallow imports from database driver packages inside schema files. Schema files must remain driver-agnostic.
- **drizzle/schema-files-must-only-export-schema** [WARN]: Restrict schema files to exporting only Drizzle schema artifacts (tables, schemas, relations, indices) and types.
- **drizzle/tables-must-have-timestamps** [WARN]: Require Drizzle tables to declare standard timestamp columns (createdAt by default).
- **drizzle/timestamp-must-specify-mode** [ERROR]: Require every Drizzle timestamp(...) call to explicitly set `mode: 'date'` or `mode: 'string'`.
- **elysia/consistent-status-via-set** [ERROR]: Inside Elysia route handlers, set HTTP status via `set.status = N`, not by returning a `new Response(body, { status: N })`.
- **elysia/no-decorate-state-collision** [ERROR]: Disallow duplicate keys across `.decorate()` / `.state()` / `.derive()` / `.resolve()` calls on a single Elysia instance — duplicates silently overwrite and break plugin composition.
- **elysia/no-separate-model-interfaces** [WARN]: Disallow TypeScript interfaces that duplicate the shape of a runtime schema with a matching name. Use `typeof Schema.static` (or your project's equivalent) instead.
- **elysia/prefer-destructured-context** [WARN]: Prefer destructured context (`{ body, set, ... }`) over passing the entire dynamic Elysia context object into controllers/services.
- **elysia/prefer-direct-return** [WARN]: Inside Elysia route handlers, return values directly instead of wrapping them in `new Response(...)` or `Response.json(...)` — Elysia handles serialization and content-type automatically.
- **elysia/prefer-static-services** [WARN]: Discourage `new Service()` inside Elysia route handlers when the class is stateless — prefer static methods or a singleton.
- **elysia/prefer-throw-status** [WARN]: Inside Elysia route handlers, prefer `throw status(...)` over try/catch blocks that build their own Response — local catches bypass Elysia's typed onError pipeline.
- **elysia/require-elysia-plugin-name** [ERROR]: Exported Elysia plugin instances must declare `new Elysia({ name: '...' })` so the runtime can deduplicate plugin re-imports.
- **elysia/require-hooks-before-routes** [ERROR]: Elysia hooks (onError, onBeforeHandle, etc.) must register before any route methods on the same instance — top-down waterfall semantics mean a hook registered after a route does not apply to it.
- **env-access/no-direct-process-env** [ERROR]: Disallow direct `process.env` access — force every consumer through a typed, boot-validated singleton.
- **env-access/no-process-exit** [ERROR]: Disallow `process.exit()` outside the centralized shutdown and CLI entrypoints — forces graceful teardown through the error-handlers module.
- **fastify/error-handler-must-set-status** [ERROR]: Custom Fastify setErrorHandler callbacks must call reply.code() or reply.status() — automatic status mapping is disabled when a custom handler is registered.
- **fastify/prefer-return-over-reply-send** [WARN]: Inside Fastify route handlers, prefer `return data` over `return reply.send(data)` so fast-json-stringify can serialize responses.
- **fastify/require-fastify-plugin-name** [ERROR]: fastify-plugin (fp) wrappers must include a `name` option so Fastify can deduplicate plugin registration.
- **fastify/require-fp-for-shared-plugins** [ERROR]: Fastify plugins that call fastify.decorate, fastify.addHook, or fastify.register must be wrapped in fastify-plugin (fp) to break encapsulation and share state.
- **fastify/require-response-schema** [WARN]: Fastify routes should declare schema.response for compiled fast-json-stringify serialization.
- **fastify/require-route-schema** [ERROR]: Fastify POST/PUT/PATCH routes must declare schema.body; GET/DELETE routes must declare schema.querystring or schema.params.
- **fastify/test-inject-must-close-app** [ERROR]: Test files using fastify.inject must register teardown that calls app.close() to drain connections.
- **i18n-keys/static-translation-key-exists** [ERROR]: Static string passed to `t("...")` or `i18n.t("...")` must exist as a leaf path in the canonical locale JSON.
- **jwt-cookies/auth-cookie-must-be-httponly** [ERROR]: Auth-cookie writes must set `httpOnly: true` (or spread a trusted cookie-config helper). JS-readable session cookies leak via XSS.
- **jwt-cookies/auth-cookie-must-be-secure-in-prod** [ERROR]: Auth-cookie writes must set `secure:` to `true` or an env-derived expression (anything non-literal). Cookies leak over HTTP without it.
- **jwt-cookies/bcrypt-rounds-min** [ERROR]: Disallow `bcrypt.hash` / `bcrypt.hashSync` calls with a numeric-literal rounds value below the configured minimum (default 10).
- **module-boundaries/no-import-build-output** [ERROR]: Disallow importing from build/output directories within the project. Source must import source, not compiled artifacts, to avoid stale-code drift and broken module boundaries.
- **module-boundaries/no-import-test-from-source** [ERROR]: Disallow production/source files from importing test files. Tests may depend on source, never the reverse — test code must not ship in the production graph.
- **module-boundaries/no-react-in-services** [ERROR]: Service and data-fetch modules must not import React — keep business logic decoupled from the view layer.
- **nextjs/await-dynamic-request-apis** [ERROR]: Require awaiting Next.js dynamic request APIs (cookies, headers, draftMode) in app-router Server Components.
- **nextjs/client-hooks-require-use-client** [ERROR]: Require the 'use client' directive in app-router page/layout/template files that call client-only hooks. Server Components cannot use state/effect/navigation hooks — doing so crashes at runtime.
- **nextjs/error-boundary-require-use-client** [ERROR]: Require 'use client' in app-router error.tsx and global-error.tsx — Next.js error boundaries must be Client Components.
- **nextjs/mutation-should-revalidate-cache** [WARN]: After database mutations in server actions or route handlers, call `revalidatePath` or `revalidateTag` so cached pages reflect the change.
- **nextjs/no-html-img-element** [WARN]: Prefer next/image over raw <img> elements for optimized responsive images and Core Web Vitals.
- **nextjs/no-internal-api-fetch** [ERROR]: Disallow Server Components from fetching the app's own /api routes — import services or ORM modules directly to avoid loopback HTTP overhead.
- **nextjs/no-next-head-in-app** [ERROR]: Disallow importing 'next/head' in app-router files. The <Head> component is a no-op under app/ — use the Metadata API (export const metadata / generateMetadata) instead.
- **nextjs/no-pages-router-data-fetching-in-app** [ERROR]: Disallow pages-router data-fetching exports (getServerSideProps, getStaticProps, getStaticPaths, getInitialProps) in app-router files. Next.js ignores them under app/, so they are silent dead code — use async Server Components or route handlers instead.
- **nextjs/no-sensitive-next-public-env** [ERROR]: Disallow NEXT_PUBLIC_* env vars whose names suggest secrets — public build-time vars are visible in the client bundle.
- **nextjs/prefer-lazy-use-state-init** [WARN]: Prefer lazy useState initializers when parsing localStorage/sessionStorage — avoids re-parsing on every render.
- **nextjs/server-only-modules-import-server-only** [ERROR]: App-router server modules must import `"server-only"` so accidental client bundling fails at build time.
- **oauth-security/pkce-required-for-oidc** [ERROR]: OIDC providers must use PKCE: `buildAuthorizationURL` must call `generateCodeVerifier()` and pass it to `createAuthorizationURL`.
- **oauth-security/state-must-be-redis-backed** [ERROR]: OAuth state must be persisted to Redis and not stuffed into a cookie. Cookie-backed state lets attackers replay forged state across sessions.
- **oauth-security/state-ttl-bounded** [ERROR]: OAuth state writes to Redis must use a short TTL — long-lived state widens the replay window.
- **react-component-architecture/dangerous-html-requires-sanitize** [ERROR]: dangerouslySetInnerHTML requires a sanitization library (DOMPurify or equivalent) imported in the same file.
- **react-component-architecture/forwardref-display-name** [ERROR]: forwardRef components must have displayName set
- **react-component-architecture/index-must-reexport-default** [ERROR]: index.ts in component folders must re-export the component default export and types
- **react-component-architecture/max-hooks-per-file** [ERROR]: Flag query/hook modules that export more than N hooks. Same-kind modules pass the single-semantic-module rule but still grow into god files; this rule sets a hard ceiling so the split conversation happens early.
- **react-component-architecture/no-anonymous-useEffect** [ERROR]: Disallow anonymous arrow functions passed to useEffect — use a named function for debuggable stack traces.
- **react-component-architecture/no-component-invocation** [ERROR]: Disallow invoking React components as plain functions — use JSX (`<Header />`) instead of `{Header()}`.
- **react-component-architecture/no-cross-feature-imports** [ERROR]: Prevent imports across different features under src/features or src/views
- **react-component-architecture/no-derived-state-in-effect** [ERROR]: Disallow setting local state inside useEffect when the value can be derived during render (or memoized with useMemo).
- **react-component-architecture/no-jsx-computation** [ERROR]: Move complex computations out of JSX into hooks or helper functions
- **react-component-architecture/no-loading-text-use-skeleton** [ERROR]: Loading states must render a <Skeleton/>, not loading text or a spinner
- **react-component-architecture/no-nested-component** [ERROR]: Disallow declaring React components inside another component body — nested components reset state on every parent render.
- **react-component-architecture/no-react-fc** [ERROR]: Disallow React.FC / FunctionComponent — type props explicitly on the function parameter instead.
- **structured-logging/caught-error-log-requires-cause** [ERROR]: When logging a caught error, include a `cause` field in the structured payload so downstream tools preserve the error chain.
- **structured-logging/mask-pii-fields** [ERROR]: Disallow unmasked PII (email, phone, password, token, ...) in structured-logger payloads — the #1 way data leaks quietly.
- **structured-logging/no-error-stringify** [ERROR]: Disallow stringifying errors with `String(error)` / `${error}` / `error.toString()` — strips the cause chain. Use a configured extractor instead.
- **structured-logging/require-event-field** [ERROR]: Require structured logger calls to include an `event` field in their payload, so log searches in ELK/Datadog/Loki don't fall back to substring match.
- **tanstack-query/prefix-query-key-must-use-set-queries-data** [ERROR]: When a hook uses `queryKey: [...prefix, extra]`, do not call `setQueryData(prefix, …)`, `cancelQueries({ queryKey: prefix })`, etc. — those only touch one cache entry. Use `setQueriesData({ queryKey: prefix }, …)` and matcher-style `cancelQueries` / `invalidateQueries` so every variant is covered.
- **test-conventions/fake-timers-must-be-restored** [ERROR]: When a test file calls `useFakeTimers()`, it must also call `useRealTimers()` so later tests are not affected.
- **test-conventions/no-conditional-expect** [ERROR]: Disallow `expect()` inside conditionals — tests must fail when assertions are skipped.
- **test-conventions/no-focused-tests** [ERROR]: Disallow focused tests (`test.only`, `it.only`, `fdescribe`, ...) — the canonical 'I forgot to remove this before committing' leak.
- **test-conventions/no-real-network-in-unit-tests** [WARN]: Unit tests should not perform real network I/O — mock HTTP clients or move the test to an integration suite.
- **test-conventions/test-file-mirrors-source** [ERROR]: Every test file under `tests/` must mirror a source file under `src/`. Catches orphaned tests left behind after refactors and renames.
- **typescript-core/exported-functions-require-return-type** [WARN]: Exported functions should declare an explicit return type at module boundaries.

### Tier: architecture

- **code-flow/prefer-early-return** [WARN]: Prefer guard clauses (early return) over wrapping the function body in a multi-statement `if` without an `else`.
- **comment-hygiene/no-historical-comments** [ERROR]: Disallow comments that frame code relative to what it used to do or to a past incident ('Codex flagged X', 'before the fix', 'after the refactor', 'we used to', 'no longer'). Source comments must describe the current invariant; history belongs in the commit message or PR description, where it doesn't rot when the code changes again.
- **comment-hygiene/no-narration-comments** [ERROR]: Disallow narrative comments like 'Here we...', 'Now we...', 'First, we...'. These read as step-by-step prose and add no information a future reader can't get from the code itself. Often a tell that the comment was generated by an agent describing its own changes.
- **comment-hygiene/no-pr-reference-comments** [ERROR]: Disallow PR/issue references in comments. They belong in commit messages and PR descriptions — leaving them in source rots when the repo moves, the issue tracker migrates, or the numbering changes.
- **react-component-architecture/component-file-purity** [ERROR]: A component .tsx contains only imports and the component itself — types go to <feature>.types.ts, constants to <feature>.constants.ts, helpers to src/lib
- **react-component-architecture/component-folder-structure** [ERROR]: A component .tsx must live in src/views/<Feature>/components/ or src/features/<Feature>/components/ (feature component), src/components/ui/ (shared primitive), or be the view root src/views|features/<Feature>/index.tsx
- **react-component-architecture/no-inline-jsx-functions** [WARN]: Disallow inline function expressions in JSX attributes
- **react-component-architecture/no-state-in-component-body** [ERROR]: State hooks must be in .hooks.ts files, not directly in components
- **react-component-architecture/one-component-per-file** [ERROR]: One top-level React component per .tsx file — move extras to their own files
- **structured-logging/logger-not-console** [WARN]: Service modules should use the structured logger instead of `console.*` — console output is unstructured and hard to search.

### Tier: experimental

- **authorization/id-param-requires-object-authz** [WARN]: Warn when a handler reads `params.id` and queries the database without an authorization check in the same function.
- **authorization/mutating-route-requires-authz** [ERROR]: POST/PUT/PATCH/DELETE route handlers must call an authorization helper before mutating state.
- **authorization/server-action-requires-authz** [ERROR]: Files with `"use server"` that perform database mutations must call an authorization helper in the same function.
- **nextjs/server-action-requires-authz-and-validation** [ERROR]: Server actions (`"use server"`) that mutate the database must call authorization helpers and validate input with `.parse()` / `.safeParse()`.

## Meta-Rules

Meta-rules enforce project structure and configuration invariants that ESLint cannot express.

### supply-chain

- **dependency-overrides-require-comment** [WARN]: overrides/resolutions in package.json must include an adjacent comment explaining why.
- **fastify-security-plugins** [WARN]: When fastify is a dependency, recommend official security plugins (@fastify/helmet, @fastify/cors, @fastify/rate-limit).
- **lockfile-required** [WARN]: Projects must commit exactly one lockfile matching the detected package manager.
- **migrations-must-be-checked-in** [WARN]: When using Drizzle, commit SQL migrations under drizzle/ or migrations/.
- **no-git-or-tarball-dependencies** [WARN]: Warn on git+, git:, or http(s) tarball dependency URLs in package.json.
- **no-overlapping-libs** [WARN]: package.json must not list forbidden overlapping library pairs (e.g. axios + node-fetch).
- **no-undeclared-dependencies** [ERROR]: Every imported package must be declared in package.json — an undeclared import works via hoisting locally but breaks on a clean install.
- **package-exact-deps** [WARN]: dependencies and devDependencies must use exact versions (no ^ or ~ ranges).
- **package-manager-field-required** [WARN]: package.json must declare a packageManager field.
- **production-must-not-use-drizzle-push** [WARN]: Do not run drizzle-kit push in package.json scripts or CI workflows.
- **single-package-manager** [WARN]: Do not mix lockfiles from different package managers in the same repo.

### config

- **next-image-remote-patterns-no-wildcards** [ERROR]: Disallow wildcard hostnames in `images.remotePatterns` — overly broad patterns enable SSRF via next/image.
- **next-instrumentation-present** [WARN]: Recommend instrumentation.ts for OpenTelemetry when using the Next.js app router.
- **next-proxy-over-middleware** [WARN]: When using Next.js 16+, prefer proxy.ts over legacy middleware.ts for early request interception.
- **tsconfig-paths-exist** [ERROR]: Literal tsconfig include/files entries must point to files that exist on disk (glob patterns exempt).
- **tsconfig-recommended-flags** [WARN]: tsconfig.json should enable recommended strict-adjacent compiler flags (useUnknownInCatchVariables, erasableSyntaxOnly, exactOptionalPropertyTypes, verbatimModuleSyntax, noPropertyAccessFromIndexSignature).
- **tsconfig-strict** [WARN]: tsconfig.json should enable strict mode for type safety (strict: true or all individual strict flags).

### source-text

- **no-eslint-disable-comments** [ERROR]: Source files must not contain inline eslint-disable directives.
- **no-ts-suppressions** [ERROR]: TypeScript suppression comments (@ts-ignore, @ts-nocheck, @ts-expect-error) are not allowed.

### testing

- **test-sibling-required** [WARN]: A logic file (one that exports a function or class) the agent changes must have a test — co-located (*.test.ts) or mirrored under tests/.

### stack-layout

- **no-circular-imports** [ERROR]: Project modules must not form import cycles (A → B → A) — they cause partial-initialization bugs and defeat tree-shaking.

### ci

- **no-github-context-in-shell** [WARN]: Do not interpolate github.event context directly in run: shell steps — pass values through env: first.
- **no-pull-request-target-untrusted-checkout** [WARN]: Disallow pull_request_target workflows that checkout the PR head ref (untrusted code with write token).
- **workflow-actions-pinned** [WARN]: GitHub Actions `uses:` directives must pin to a version tag (v1, v2, etc.) or full SHA, not floating refs like @main.
- **workflow-permissions-explicit** [WARN]: GitHub Actions workflows must declare permissions at the workflow or job level.
- **workflow-permissions-least-privilege** [WARN]: Warn when workflow-level permissions grant contents: write or id-token: write.
- **workflow-runner-pinned** [WARN]: Workflows must pin runner images to an explicit OS version (e.g. ubuntu-24.04) instead of floating *-latest labels.
- **workflow-timeout-required** [WARN]: GitHub Actions jobs require an explicit timeout-minutes (reusable-workflow calls exempt).

### container

- **dockerfile-base-image-pinned** [ERROR]: Dockerfile FROM instructions must pin an explicit non-latest tag (or a digest) so image builds are reproducible.
- **dockerfile-no-secrets-in-env-arg** [ERROR]: Dockerfiles must not assign secret-looking ENV/ARG values (KEY/TOKEN/SECRET/PASSWORD) — they bake into image layers. Inject secrets at runtime.
- **dockerfile-non-root-user** [ERROR]: Dockerfiles must declare a non-root USER so the container process does not run as root.

## Out of scope

The following are intentionally deferred — wrong tool for the syntactic ESLint gate, or require cross-file analysis:

- GraphQL/WebSocket/OpenAPI contract rules (until OpenAPI dep + parser)
- Kubernetes / Compose YAML hardening (Dockerfile hardening now ships as container meta-rules)
- MCP-server security pack (the AI-SDK pack now covers `ai`/`openai`/Anthropic clients)
- FSD layer DAG / full authorization taint tracking
- Lighthouse / bundle-analyzer CI gates
- Violation ratcheting / baseline snapshots (Phase 5)
