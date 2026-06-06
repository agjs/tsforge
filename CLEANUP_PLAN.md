# tsforge harness cleanup — bring our OWN code to boringstack quality

> Goal: the harness must *exemplify* the strict-TS discipline it enforces on targets.
> Right now it doesn't — it compares bare strings everywhere instead of `as const`
> registries, has two 500–700-line god-files mixing many concerns, duplicated helpers,
> scattered `process.env` + magic numbers, and an own-gate (`eslint.config.js`) that's
> too lax to have caught any of it. This is a **behavior-preserving refactor + gate
> hardening** pass to do BEFORE new features.

## Reference: the boringstack (`/agjs/code/boringstack`)
The boringstack (apps/api + apps/ui) is the quality bar. It enforces its rules via a big
`eslint.config.js` + a custom `lint-meta` engine. **Most of its rules are domain-specific
(Elysia/Drizzle/BullMQ/Stripe/React/a11y/i18n) and DO NOT apply** to this harness, which is
a CLI/library, not an API or a React app. Port only the **transferable** conventions below.

### Transferable conventions to adopt
1. **`as const` registries instead of bare string comparisons.** boringstack bans
   `TSEnumDeclaration` and bans `=== "ENUM_SHAPED"` literals; values live in `as const`
   objects (`ROLE = { owner: "owner", ... } as const`) and code compares `role === ROLE.owner`.
   Our discriminants are type-safe unions but compared as raw strings — convert them.
2. **One semantic concern per file** (`module-boundaries/single-semantic-module`): types,
   constants, and logic don't get dumped together; big files split by concern.
3. **Module folders, not flat dumps** — related files grouped; a folder exposes `index.ts`.
   (We are a library, so we DON'T use the API's `*.service.ts/*.routes.ts` suffixes — we use
   per-module `types.ts` / `constants.ts` + grouped folders.)
4. **No scattered `process.env`** (`env-access/no-direct-process-env`): env read in ONE place,
   typed, documented.
5. **Centralized constants** — no magic numbers inline; named, documented, single home.
6. **No duplication** (`sonarjs/no-identical-functions`, canonical helper homes).
7. **Comment hygiene** (`comment-hygiene/no-historical-comments`, `no-narration-comments`):
   keep timeless *why* comments; drop dated/narration/changelog comments (move the history to
   memory/docs, not the source).
8. **Strict type boundaries**: no `any`/`as`/`!`; decode untrusted input into concrete types at
   the boundary instead of threading `Record<string, unknown>` + `typeof x === "string"` deep.
9. **Lint hardening**: adopt the transferable rules our `eslint.config.js` is missing (below).

### Explicitly OUT of scope (do NOT do)
- API/UI-domain lint rules (elysia, drizzle, bullmq, stripe, audit-log, oauth, jwt, react,
  jsx-a11y, i18n, tanstack) — irrelevant here.
- Building a custom eslint-plugin / lint-meta engine — use off-the-shelf plugins + `no-restricted-syntax`.
- The `*.service.ts/*.routes.ts/*.schemas.ts` resource-suffix scheme — that's API-domain.
- Changing `src/constitution/baseline.ts` (what we impose on TARGET repos) in ways that alter
  eval behavior — treat that as a separate, careful, optional sub-task (Phase 6), gated on the
  eval suite still passing.

---

## Audit findings (verified, with file:line)

### A. Bare string-literal comparisons → need `as const` registries
Discriminants compared as raw strings instead of named constants:
- **RunStatus** `"done" | "stuck" | "red-not-confirmed"` — `loop/run.ts:22`, compared at
  `cli.ts:118,121`, `loop/run-spec.ts:49`.
- **Spec mode** `"existing" | "scratch"` — `spec/parse.ts:26`, `loop/run.ts` (hasExistingCode logic).
- **Edit reason** `"ambiguous" | "not-found" | "missing-file"` — `loop/execute-tool.ts:435`,
  `agent/model-agent.ts:123`.
- **Finding kind** `"unsatisfiable" | "over-strict" | "ambiguous" | "ok"` — `spec/review-tests.ts:117-120`.
- **Tool names** — a 13-way `if (call.name === "read") … === "run" … === "edit" …` chain at
  `loop/execute-tool.ts:117-149`; also `agent/model-agent.ts:90,138`.
- **Event kinds** `"start"|"red"|"cycle"|"token"|…` — `loop/events.ts:3-16` (already a clean union +
  exhaustive switch in `render/ansi.ts:68`; this one is the model to follow, leave the switch).
- **Env flags** `=== "1"` — `loop/run.ts:63,97,254` (`TSFORGE_NO_LSP_TOOLS`, `TSFORGE_LEGACY_FEEDBACK`,
  `TSFORGE_NO_ASTGREP`).

Fix: one `as const` registry per discriminant (e.g. `src/loop/status.ts` `export const RUN_STATUS = {...} as const`),
derive the union type from it (`type RunStatus = typeof RUN_STATUS[keyof typeof RUN_STATUS]`), and replace
every bare-string comparison with the named member. Build a **tool registry** (name → handler) to replace
the `if`-chain dispatch. Keep the event-kind union+exhaustive-switch as the reference pattern.

### B. God-files mixing concerns
- **`loop/run.ts` (706 lines)** tangles: the task loop, gate-settling, file-section rendering
  (`renderFileSection`/`projectMap`/`exportedSymbols`, ~lines 471-535), error/gate-feedback
  formatting (~645-687), `readFiles` IO (691-709), timing. → split into `loop/coordinator.ts`
  (the loop), `loop/feedback.ts` (gate-feedback rendering), `loop/project-map.ts`
  (`renderFileSection`/`projectMap`/`exportedSymbols`), `lib/files.ts` (`readFiles`).
- **`loop/execute-tool.ts` (483 lines)** tangles: 13-way dispatch, LSP execution, search,
  read/run/edit/create IO, scope checks, arg parsing/repair, rejection telemetry. → split into
  `tools/registry.ts` (dispatch), `tools/file-ops.ts` (read/run/edit/create), `tools/lsp-ops.ts`
  (the 6 LSP tools + search), `tools/args.ts` (decode/repair).
- **`inference/openai-compatible.ts` (436 lines)** tangles HTTP transport + retry, wire mapping
  (`toWire`/`parseResponse`), streaming SSE assembly, and `salvageToolCalls`. → split into
  `inference/transport.ts` (fetch+retry), `inference/wire.ts` (toWire/parseResponse/salvage),
  `inference/stream.ts` (SSE accumulator).

### C. Duplication
- `readFiles()` defined twice — `agent/model-agent.ts:196` AND `loop/run.ts:691`. → `lib/files.ts`.
- Process stdout/stderr reading repeated 4× — `loop/astgrep-fix.ts:39`, `validate/run-tests.ts:39-40`,
  `validate/accept.ts:25-26`, `agent/tools.ts:284-285`. → `lib/process.ts` `readProcessOutput()`.
- `Bun.file(...).exists()` ad-hoc in 6+ places. → `lib/files.ts` `fileExists()`.
- Scope checks (`writable()` + `scratch/` hardcode) repeated — `execute-tool.ts:51-53,277,305,392,456`
  and `model-agent.ts:179-194`. → consolidate in `lib/scope.ts` with a typed reason.

### D. Magic numbers + scattered config
- `MAX_OUTPUT=4000` (`execute-tool.ts:38`), `MAX_EDIT_LINES=50` (`:46`), `GATE_STUCK_LIMIT=10`
  (`run.ts:76`), `MAP_THRESHOLD=12000` (`run.ts:471`), backoff `400*attempt`
  (`openai-compatible.ts:120`), timeout `600000` (`:62`).
- **Bug: maxTokens default mismatch** — `cli.ts:100` uses `16384`, `openai-compatible.ts:36` uses
  `8192`. Pick one source of truth.
- → `src/constants.ts` (documented, single home) + `src/config.ts` (typed env reader; the ONLY place
  that touches `process.env`; flags become `config.noLspTools` etc.).

### E. Type-safety gaps
- Tool args threaded as `Record<string, unknown>` with 26+ `typeof x === "string"` defensive checks
  deep in handlers (`execute-tool.ts`, `tools.ts`, `model-agent.ts`, `openai-compatible.ts`). →
  decode once at the boundary into concrete per-tool arg types; handlers receive typed args.

### F. Our own gate is too lax (`/agjs/code/ant/eslint.config.js`)
Already has: no-explicit-any, no-non-null-assertion, consistent-type-assertions(never),
no-floating-promises, no-misused-promises, strict-boolean-expressions, naming-convention,
switch-exhaustiveness-check, no-console, require-await, restrict-template-expressions,
padding-line, consistent-type-imports, no-restricted-syntax(enum ban only), no-unsafe-{argument,
assignment,member-access}, await-thenable, no-base-to-string, no-confusing-void-expression.

**Add the transferable missing rules** (off-the-shelf only):
- `@typescript-eslint/no-unsafe-call` + `no-unsafe-return` (complete the unsafe family).
- `@typescript-eslint/prefer-nullish-coalescing`, `prefer-optional-chain`, `no-unnecessary-condition`,
  `return-await: ["error","in-try-catch"]`, `no-unsafe-enum-comparison`.
- `no-throw-literal` / `@typescript-eslint/only-throw-error`.
- `eslint-plugin-sonarjs`: `cognitive-complexity` (catches god-files), `no-duplicate-string`,
  `no-identical-functions`, `no-useless-catch`, `prefer-immediate-return`.
- `eslint-plugin-unicorn` (curated subset): `prefer-string-starts-ends-with`, `prefer-includes`,
  `prefer-ternary`, `throw-new-error`, `no-lonely-if`, `error-message`, `prefer-array-some`,
  `prefer-array-find`, `no-useless-spread`.
- `eslint-plugin-import`: `no-duplicates`, `no-self-import`, `no-useless-path-segments`, `first`.
- `@eslint-community/eslint-plugin-eslint-comments`: `no-use` (ban inline eslint-disable).
- `id-length: ["error", { min: 2, exceptions: ["i","j","k","_","a","b","x","y","n","m","e"] }]`
  (tune exceptions to avoid churn; tests may relax).
- `eqeqeq: ["error","always"]`, `curly: ["error","all"]` if not already implied.
- `no-restricted-syntax` additions: ban bare `new Date()`/`Date.now()` in `src/**` (centralize time
  if/when needed); optionally a project rule nudging discriminant comparisons toward registries
  (only if it doesn't create noise — the registries themselves are the real fix).
- Set `cognitive-complexity` threshold generously first (e.g. 25), let it flag the god-files, split
  them, then ratchet down.

---

## Execution plan (phased; gate green + eval-smoke between phases)

**Phase 0 — harden the gate first (so the refactor is guided by it).**
Add the missing eslint rules + plugins above to `eslint.config.js` with generous thresholds.
`bun run validate` will now surface violations — that list drives Phases 1-4. Commit the config.

**Phase 1 — `as const` registries + tool registry.**
Create registries for RunStatus, spec mode, edit reason, finding kind, tool names, env flags.
Replace every bare-string comparison. Replace the `execute-tool.ts` if-chain with a name→handler
registry. Derive union types from the registries. Tests stay green.

**Phase 2 — centralize constants + config + dedupe helpers.**
`src/constants.ts` (all magic numbers, documented; fix the maxTokens 8192/16384 bug). `src/config.ts`
(only place reading `process.env`; typed flags). `lib/files.ts` (readFiles, fileExists),
`lib/process.ts` (readProcessOutput), consolidate `lib/scope.ts`. Remove the duplicates.

**Phase 3 — split the god-files by concern.**
`loop/run.ts` → coordinator + feedback + project-map + lib/files. `loop/execute-tool.ts` →
tools/{registry,file-ops,lsp-ops,args}. `inference/openai-compatible.ts` → transport + wire + stream.
Behavior-preserving; tests are the safety net. Re-group into module folders with `index.ts` barrels
where it clarifies (e.g. `src/tools/`, `src/inference/`).

**Phase 4 — type the tool-arg boundary.**
Concrete per-tool arg types decoded once (in `tools/args.ts`); delete the deep `typeof` defensive
checks. No `any`/`as`/`!`.

**Phase 5 — comment hygiene + final ratchet.**
Drop dated/narration/changelog comments from source (the rationale lives in memory/docs); keep
timeless *why*. Ratchet `cognitive-complexity` and `no-duplicate-string` thresholds down to the
boringstack levels (20 / 5) now that the code is split. Final `bun run validate` green.

**Phase 6 (optional, careful) — sync `src/constitution/baseline.ts`.**
Bring the transferable rules into the constitution we impose on TARGET repos, IFF the eval suite
(money scratch + react-board existing) still runs green afterward. This changes target behavior, so
A/B it; revert if it regresses evals. Lower priority than Phases 0-5.

## Guardrails
- `bun run validate` (tsc + eslint + prettier + 157 tests) GREEN after every phase. Tests are the
  refactor safety net — if a split breaks behavior, a test fails.
- Behavior-preserving: this is cleanup, not features. No functional change to the loop/gate/provider.
- After Phase 3 and at the end, **smoke the eval suite**: one `money` (scratch) run and one
  `react-board` (existing) run must still reach green. Single GPU — serialize, `run_in_background`.
- No `any`/`as`/`!`. No inline `eslint-disable` (the new `eslint-comments/no-use` forbids it).
- Don't touch the eval target fixtures under `evals/` or the memory files.
- Commit per phase with a clear message so the refactor is bisectable.
