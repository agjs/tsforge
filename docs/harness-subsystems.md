# Harness subsystems — review manifest

The map the `harness-review` skill works from. tsforge is a TypeScript-specialized
agent harness: it proposes edits, builds, and runs a deterministic gate until the
work is green. The risky surface isn't "does the model write good code" — it's the
**harness contracts**: that every mutation re-gates, that no child outlives a kill,
that a tool tells the model the truth, that plan mode can't write.

Each entry lists the source it owns, the **invariants** that must hold, the known
risk areas, and a focused review checklist. Review ONE subsystem at a time: read its
source + tests, check each invariant against the code, and try to break it (a quick
repro beats a hunch). A finding is only real once reproduced or traced to a concrete
line. Severity: **P1** correctness/safety (silent data/gate loss, a kill that leaks,
a guard that doesn't guard); **P2** a partial fix, missing test, or hidden failure;
**P3** clarity/robustness.

---

## loop / turn — `src/loop/turn.ts`, `src/loop/session.ts`, `src/loop/loop.types.ts`, `src/loop/run.ts`

Drives a turn: dispatch tool calls, account for writes, re-gate, settle. `run.ts` is the
headless outer driver (max-turns gating, degeneration/TTSR handling, gate settling) that
iterates `turn.ts`; `model-call.ts` (PR #66) composes out of Session.

**Invariants**

- Every workspace mutation re-gates. A tool that writes without the model
  hand-writing it must surface `event.mutated`; an `edit`/`create` surfaces `event.file`.
- A write is counted ONLY when it actually wrote (no name-based pre-counting — a
  rejected/no-op op must not let a green gate claim "done").
- The per-write guard runs on hand-written files only, never on generated/vendored shells.
- Mutated paths join the change scope (so change-scoped rules cover them).

**Risk areas** new mutating tool that forgets `mutated`; re-gate keyed off tool name;
scope check on the raw arg instead of the normalized written path.

**Checklist** every mutating tool emits `mutated`/`edit`/`create` (cross-check the
`tools` table); rejects emit nothing; `countsAsMutation` exempts only `package.json`.

## loop / repair + snapshot — `src/loop/file-snapshot.ts`, `src/loop/quality.ts`, `src/loop/review-repair.ts`

"Try an edit, keep only if it helps" loops: snapshot the editable scope → let the
agent edit → re-gate (and for quality, re-judge) → keep only on improvement, else
roll back. The revert is the load-bearing safety property.

**Invariants**

- Snapshot/restore is glob-aware: `task.files` is documented as GLOBS, so anything
  that walks the scope must expand them (`snapshotFiles`, `score`, `scopeCode` all
  go through the shared walker), never read a literal glob path.
- Restore rewrites every content-backed file AND tombstones any file the attempt
  created (binary-inclusive, uncapped scan — a created `.svg`/image must be deleted,
  or "reverted" lies). Pre-existing files survive.
- A `reverted` event carries `count` = the batch's mutation count (so accept-rate
  subtracts the whole batch, not 1).
- A throw mid-repair still restores before rethrowing (no half-applied batch on disk).

**Risk areas** a scope walker that reads `task.files` literally (ENOENT on a glob —
fixed in `score`); content cap (128 KiB) silently NOT restoring an edited oversize/
binary file while still emitting `reverted`; a created dir left behind (cosmetic).

**Checklist** `tests/file-snapshot.test.ts` (glob expand, tombstone, binary asset),
`tests/quality.test.ts` (glob scope, gate-break revert), `tests/review-repair.test.ts`
(throw-restores, batch `count`).

## loop / greenfield — `src/loop/greenfield/*`

Filesystem-state outer loop: a `features.json` checklist drives a unified loop (shared `settleGate`→`checkStuck`→escalation-ladder in `loop/turn.ts`) per feature until all green or a feature exhausts its attempts. The loop's gate is an injected composable `IGate` object (command → differential → reachability → judge stages) that runs INSIDE the loop, so the escalation ladder sees real lint/judge failures for every mode.

**Invariants**

- Feature ids come from the model, so they're validated kebab (`isFeatureId`) at
  parse/load and unsafe ids are dropped (defence against `../` traversal). Greenfield
  writes only `features.json` / `spec.md` / `progress.md` (no per-feature contract files).
- State persists after every attempt (resume-first: an interrupted run picks up from
  the last verified feature; a feature loaded at `attempts>=max` is `stuck`, never re-run).
- The evaluator is layered + short-circuits gate → browser → judge; the gate stays
  the authority, the browser layer is skip-tolerant, the judge is reject-by-default
  and trace-blind (design-rule #2: it sees the built artifact, never the generator trace).

**Risk areas** an unsafe id slipping past `isFeatureId`; an exhausted feature wedging
the loop; the judge seeing the generator's trace.

**Checklist** `tests/greenfield.test.ts`, `tests/greenfield-planner.test.ts`
(unsafe-id drop). (The `TSFORGE_CONTRACT` negotiation feature + `contracts/<id>.md`
writes were removed — no contract test.)

## tools — `src/loop/tools/*`

Tool handlers + dispatch. Handlers return a `string` (model feedback); mutations are
reported via `ctx.report(ILoopEvent)`, never the return value.

**Invariants**

- Mutating tool ⇒ reports a change (or is in `SPECIAL`: `run`, `script`).
- Mutation events fire ONLY on a real change (empty/no-op ⇒ no event).
- A failure returns a tool-error string — never throws into the loop.
- A tool's text must not lie about state (e.g. "deps installed" when install failed).
- Plan mode: every mutating tool is rejected at dispatch (a salvaged/forced call too).

**Risk areas** silent mutation (a generator/wiring step that writes without reporting); a handler that throws;
optimistic success text; arg parsing that accepts a flag/path injection.

**Checklist** run `tests/tool-accounting.test.ts` (the classification table is the
guard); for each mutating tool confirm the `mutated`-only-on-success path; grep
handlers for `throw` reaching the caller.

## gate / detect-gate — `src/gate/*`, `src/validate/*`

Composes the gate command (tsc strict + eslint + opt-in oracles) and the fix/auto-format.
(PR #66 split the old single files: `src/gate/*` = `core-gate.ts`, `web-gate.ts`,
`linter.ts`, `tsconfig.ts`, `shell.ts`, `test-discovery.ts`, `tool-paths.ts`,
`types.ts`; `src/validate/*` = `validate.ts`, `accept.ts`, `parse.ts`, `run-tests.ts`,
`errors.ts`.)

**Invariants** the gate uses tsforge's OWN bundled toolchain (works on any target);
opt-in oracles only join when their env var is set; a failing gate never reports green.

**Risk areas** error-parser fallback dumping a raw blob; opt-in oracle wired in by default.

**Checklist** each opt-in oracle is env-gated; combined parser degrades legibly.

## oracles — `scripts/boot-check.ts`, `src/browser/oracle.ts`, `scripts/*-check.ts`

"Does it RUN / render / stay covered" — failure classes tsc/eslint miss.

**Invariants** In the CORE gate, boot (`TSFORGE_BOOT`), proptest (`TSFORGE_PROPTEST`),
and coverage (`TSFORGE_COVERAGE`) are opt-in via env (`appendOptInOracles`); the browser
render-check runs only as the greenfield evaluator's optional browser layer (the
Playwright oracle), skip-tolerant when Playwright is absent so it never blocks. Ephemeral
ports via the shared `serveEphemeral` retry apply to the port-binding oracles only
(`boot-check`, `browser` oracle); the non-serving oracles (`proptest-check`, `test-coverage-check`)
spawn via `runArgvCommand`/`Bun.spawn` with a timeout-kill and bind no port. A browser
absence skips, not fails.

**Risk areas** raw `Bun.serve({port:0})` (EADDRINUSE on old Bun); a server left running.

**Checklist** ports go through `src/lib/serve.ts`; servers `stop()` in a `finally`.

## browser — `src/browser/oracle.ts`

Playwright render/route oracle + static server.

**Invariants** files served over http (not file://); missing assets 404 (broken bundle
surfaces); SPA fallback only for extension-less paths; redirect/private-host guards hold.

**Checklist** SPA fallback can't mask a missing asset; server torn down per run.

## inference / provider — `src/inference/*`, request builder, stream guard

OpenAI-compatible client, streaming, the StreamGuard loop protection, tok/s.

**Invariants** a NaN tuning param never reaches the wire; the StreamGuard cuts a
degenerate stream; reasoning/content channels are kept distinct.

**Risk areas** repetition penalty penalizing tool-call JSON (→ narration, no writes);
reasoning-token capture for the active provider dialect.

## rule-packs / meta-rules — `src/meta-rules/*`, `src/rule-packs/*`, `src/infer-rules/*`, `scripts/build-rule-docs.ts`

ESLint rule packs, structural meta-rules, profile gating.

**Invariants** every shipped rule has a doc card and vice versa (parity); type-aware /
profile-gated rules only fire under their profile; meta-rules are change-scoped.

**Checklist** `tests/rule-docs.test.ts` parity; a profile-gated rule is off by default.

## render / CLI — `src/cli.ts`, `src/render/*`

Spinner, pinned status bar (`status-bar.ts`), the multi-line input editor (driven via
`src/editor/*`, replacing the old readline REPL since PR #52), command palette
(`command-menu.ts`), `@`-file picker (`file-menu.ts`), setup wizard (`wizard.ts`),
plan-mode wiring.

**Invariants** the status bar tears down idempotently on exit/resize/clear and never
leaves a scroll region pinned after exit; the editor block is BOTTOM-anchored and a
shrink clears its old top rows (no ghost rows) — same for the `@`-picker overlay
(`buildOverlayFrame`); streamed agent output scrolls in the region ABOVE the pinned
input, never over it; a terminal resize updates BOTH the bar's scroll region AND the
editor's wrap/window dimensions (the editor caches its size — `IEditorHandle.resize`
must be called or the current line is clipped at the stale size); mid-turn input is
queued, not dropped.

**Risk areas** inline spinner clobbering input on a tiny TTY (the fixed P2b); a scroll
region left pinned after exit; **stale editor dimensions after resize** (fixed: PR #54
— editor cached columns/rows and the resize handler only re-pinned the bar); a render
function asserted by escape-string substring instead of the rendered grid (use the
`VirtualScreen` e2e harness — `tests/helpers/virtual-screen.ts` — which is what caught
the ghost-row / non-ASCII / cursor-clip bugs string assertions missed).

**Checklist** spinner inline gate off in the interactive REPL; teardown on
`process.on("exit")`; resize handler calls `statusBar.resize` AND `editorHandle.resize`.

## editor — `src/editor/*` (`buffer.ts`, `completion.ts`, `controller.ts`, `index.ts`, `keys.ts`, `kill-ring.ts`, `paste.ts`, `segments.ts`, `undo-stack.ts`, `view.ts`)

The multi-line input editor that replaced readline: a grapheme-correct buffer, a key
decoder (Kitty CSI-u + modifyOtherKeys + legacy), a bracketed-paste scanner, a
wrap/window view renderer, and a controller wiring stdin → buffer → `setEditor`.

**Invariants** cursor offsets are grapheme indices, never UTF-16 (`segments.ts`); a
paste NEVER auto-submits — Enter submits, Shift/Alt+Enter and a trailing `\`+Enter
insert a newline (`controller.ts`); all printable input is accepted, including
non-ASCII / emoji / CJK — only C0/DEL/C1 controls are rejected (`keys.ts` — a
`charCodeAt >= 0x7f` guard dropped every non-ASCII char, fixed via `codePointAt`);
multi-line insert + undo is atomic; the view windows to the editor's visible capacity
(`rows - EDITOR_RESERVED_ROWS`) so the cursor line is always shown.

**Risk areas** a key guard that drops a valid grapheme; an in-place repaint that ghosts
on shrink (top- vs bottom-anchored block); stale dims after resize; a paste path that
auto-submits. **Tested via the `VirtualScreen` e2e harness** (`tests/editor-e2e.test.ts`)
— assert the rendered grid, not emitted escape strings.

## policy — `src/policy/*` (`policy.ts`, `classify.ts`, `patterns.ts`, `policy.types.ts`)

The deny-first unified action policy (PR #23): classify every tool call into an action
kind, then evaluate it against the mode's rules BEFORE any handler runs. The critical
denials (`isDestructiveShell`, `pipesToShell`, `commandReadsPrivateKey`,
`isPrivateKeyPath`) win in EVERY mode, `bypassPermissions` included.

**Invariants**

- Deny-first ordering: `executeTool` evaluates the policy before dispatch, so no tool
  path (forced, salvaged, MCP, `script`/PTC, plan-mode) reaches a handler unpoliced.
- The critical-deny set holds in every mode, and its shell detectors see through the
  disguises a naive head-check misses — substitution, subshell, `find -exec`,
  interpreter `-c`, quote-wrapping, AND shell function / brace-group bodies
  (`f() { rm -rf /; }`). New shell syntax that hides a destructive head is the standing
  risk (each escape is a P1: a guard that doesn't guard).
- Private-key material is denied to BOTH `read` and the `run` shell (the `run` tool must
  not be a side door around the `read` deny); `.env` is deliberately allowed.
- MCP/unknown actions are policed (deny-by-default for unclassified), and a malformed
  policy-rule config drops the bad rule rather than opening a hole.

**Risk areas** a new evasion syntax past `patterns.ts`; deny-first ordering broken by a
refactor that moves `executeTool`; a tool kind that classifies to an unpoliced action.

**Checklist** `tests/policy-evaluation.test.ts` (destructive-shell + pipe + private-key
detectors, incl. function/brace-group bodies), `tests/policy-config.test.ts` (rule
parse/drop), `tests/policy-integration.test.ts` (deny-first at `executeTool`),
`tests/write-policy-p1.test.ts`.

## agent / subagents — `src/agent/*` (`agent-runner.ts`, `agent-scheduler.ts`, `builtin-specs.ts`, `agent-spec.ts`, `agent.constants.ts`), `src/cli/spawn-runner.ts`, `src/loop/tools/spawn-agent.ts`, `src/config/agent-specs.ts`, `src/render/agent-tree.ts`

Model-driven delegation (PRs #73–79): the orchestrator hands focused, READ-ONLY
investigation to specialist subagents via the `spawn_agent` tool. `AgentRunner` composes
the turn primitives directly (no gate); `makeLimiter` caps concurrency; subagents return a
structured `agent_result` and auto-compact so a long investigation never overflows; the run
renders as a live navigable tree above the input row.

**Invariants**

- Read-only is STRUCTURAL (3 layers): advertised tools = read-only set ∩ spec subset;
  `ctx.tool.readOnly=true` hard-rejects mutation at dispatch; the policy layer evaluates
  first. `spawn_agent` is NEVER offered to a subagent → recursion depth capped at 1.
- Never overflows: proactive compaction fires before a request crosses the EFFECTIVE
  window (`window − reserve`, reserve capped at ½ window so a small model can't loop); a
  context-overflow 400 is caught, compacted (bounded transcript; fixed fallback when the
  window is unknown), and retried once; a non-overflow error still surfaces.
  `buildBoundedTranscript` output is ALWAYS ≤ `maxChars` (marker + separators counted).
- Structured output: `agent_result` = `{summary, findings:[{detail, source, confidence}]}`;
  malformed/legacy `{result}` args fall back without crashing; a finding with no `detail`
  is dropped (no bare bullet).
- Concurrency: `makeLimiter` honors the cap and RELEASES the slot even when a body throws
  (no deadlock); one failing subagent doesn't sink siblings; consecutive spawns run
  concurrently but a non-spawn tool (edit) is an ordering barrier; tool replies keep
  submission order.
- Live tree: every emitted line ≤ `columns − 1` (renders nothing below the minimum usable
  width, so a terminal never self-wraps a line); no OutputRouter sink leak (every installed
  sink is cleared on turn end, incl. an agent that streamed nothing); lifecycle events drive
  the tree, not the transcript.
- Spec precedence built-in < global < project (same id overrides); malformed specs skipped,
  not fatal. `TSFORGE_NO_DELEGATION=1` withholds delegation entirely (single-stream).

**Risk areas** a mutation or `spawn_agent` slipping past the read-only filter (recursion); a
compaction path that overflows or infinite-loops; a limiter slot leaked on throw (deadlock);
a sink leak mis-routing a later turn's output; the turn-loop spawn-batch reordering edits
after a spawn.

**Checklist** `tests/agent-runner.test.ts`, `tests/agent-compaction.test.ts`,
`tests/agent-structured-output.test.ts`, `tests/agent-scheduler.test.ts`,
`tests/spawn-concurrency.test.ts`, `tests/tool-accounting.test.ts` (spawn batch +
edit-before-spawn ordering), `tests/agent-tree.test.ts`, `tests/agent-tree-render-e2e.test.ts`,
`tests/policy-evaluation.test.ts` (spawn_agent class), `tests/logging-lifecycle.test.ts`,
`tests/output-router.test.ts`; PTY: `scripts/e2e-spawn-agent-pty.py`,
`scripts/e2e-agents-pty.py`.

## mcp — `src/mcp/*`

Hand-rolled JSON-RPC 2.0 client/server, tool registry.

**Invariants** MCP tools bypass the editable scope + the deterministic gate (external
context, never workspace mutations); a dead server degrades, not crashes.

## boringstack build — `src/scaffold/*`, `src/loop/boringstack/*`

Web apps are built on a real BoringStack clone, not a tsforge-invented stack (the old
UI-only Vite/React `scaffold_web`/`scaffold_ui`/`scaffold_routes` subsystem was removed).
Two phases: (1) **scaffold** (`src/scaffold/`) clones + configures BoringStack from its
own manifest; (2) **build** (`src/loop/boringstack/`) drives the [greenfield engine](loop)
one resource per feature — `generate.ts` runs BoringStack's generators, `wire-resource.ts`
does the deterministic wiring (routes/app/swagger + `tests/helpers/db` re-export),
`build.ts` auto-fixes (prettier + `eslint --fix`) then runs `gate.ts` **baseline-aware
and differential** via `extract-failures.ts`, and the model fills the domain scoped to
that resource's files, frozen on green.

**Invariants** the harness owns generators + wiring, the model owns domain; the gate is
BoringStack's OWN `validate` (never relaxed); a feature passes only when it introduces
NO new failures beyond the pristine baseline; wiring edits are idempotent (a retry
re-runs safely). "Done" = BoringStack's composed gate green on the model's slice.

## setup / conventions — `src/infer-rules/*`, `src/setup/*`, `src/render/wizard.ts`, the bundled `.mjs` configs

`tsforge setup` infers a repo's conventions (interface naming, enums, test layout,
component folders) and writes them to `tsforge.config.json`. The contract is that
conventions are **taste only** and a single source drives BOTH enforcement and
guidance, so the gate and the prompts can never disagree.

**Invariants**

- The safety floor (no `any`/`as`/`!`, complexity cap, `eqeqeq`, `no-var`,
  `prefer-const`) can NEVER be relaxed through `conventions` OR `TSFORGE_RULE_OVERRIDES`,
  on either bundled surface — enforced by `PROTECTED_BUNDLED_RULES` +
  `applyBundledOverrides`, surface-aware (only protects a rule the surface already has).
- Allowing enums removes ONLY the enum selector; the `as`/`<>` cast bans stay.
- A DEFAULT convention set emits no `TSFORGE_CONVENTIONS` and the `.mjs` fallback equals
  the old hardcoded rules — a default project is byte-identical to pre-feature.
- A failed import of the convention builder inside a `.mjs` falls back to the hardcoded
  house-style rules (never silently drops the enum/cast/naming bans).
- The gate (`TSFORGE_CONVENTIONS` env via `packEnvPrefix`) and the write-time linter
  (`makeFileLinter` overrideConfig) resolve the SAME conventions.
- The wizard writes nothing until Apply; cancel/back writes nothing; the interactive
  driver restores keypress listeners + cursor on every exit path (no terminal wedge).
- The writer preserves unrelated config keys; the conventions block is wholly
  setup-owned (a re-run replaces it, or removes it when all choices are default).
- The scanner is read-only (TS AST only) and never executes a target's config; bounded
  by MAX_FILES/MAX_BYTES.

**Scope note (deliberate, documented)** Conventions govern the CORE/brownfield path
(auto gate + `buildSystemPrompt`/chat/TDD + write-time linter). The boringstack BUILD
path (`src/loop/boringstack/*`) instead defers entirely to BoringStack's OWN gate and
conventions (the `pull_conventions` library + refine prompt) — tsforge holds no stack
style of its own there. The eval-sweep agent (`src/agent/model-agent.ts`) also still
carries house-style guidance (eval-only path). Both are tracked follow-ups, not bugs.

**Risk areas** an override key slipping past the protected set; a `.mjs` rebuild that
drops a ban; the gate honoring a convention the prompt contradicts; a wizard exit path
that leaks keypress listeners.

**Checklist** `tests/eslint-conventions.test.ts` (guard + split), `tests/gate-conventions.test.ts`
(real spawned gate), `tests/prompt-conventions.test.ts` (no stale I-prefix),
`tests/wizard.test.ts` (reducer/render/lifecycle), `tests/write-config.test.ts` (merge),
`tests/scan.test.ts` (read-only + caps).

## lib/fs — `src/lib/fs/process.ts`, fs helpers, `src/lib/scope/scope.ts`

The ONE shared command runner; path normalization; scope checks.

**Invariants** ONE place runs shell commands (gate + `run` + the `--notify` hook all
route through `runShellCommand`/`runArgvCommand`) so cancellation + kill-timeout are
uniform; a timeout/abort kills the whole process group (no leaked `&` child); the
final output drain is always bounded (`FLUSH_GRACE_MS`); argv (no-shell) form for any
content-built command (e.g. `add_dependency` → `bun add …`) — the model's own `run`
tool is the one deliberate shell form, gated by `isReadOnlyCommand` in plan mode and
the destructive-shell policy otherwise; a missing binary → exit 127, not a throw; a
custom `env` REPLACES the inherited env (pass `{ ...process.env, … }` to add a var).
The long-lived MCP stdio transport (`src/mcp/stdio-transport.ts`) is the one
deliberate exception — a persistent server, not a one-shot command.

**Risk areas** kill that leaves grandchildren (the fixed P2a); shell-injection via the
shell form; an uncapped read; a NEW spawn site that bypasses the runner and so skips
the kill-timeout (the fixed `runNotify` hang).

**Checklist** `tests/process.test.ts` group-kill + bounded drain + missing-binary 127

- custom env; `tests/cli.test.ts` `runNotify` is timeout-bounded; content-built
  commands use `runArgvCommand`.

---

## Out-of-scope follow-ups (tracked, not yet built)

- **PTY typing e2e**: a real `node-pty` test that types during a live turn and asserts
  the readline buffer survives. Deferred to avoid a native dep in the stability phase;
  the deterministic spinner-write unit test (`cli.test.ts`) covers the regression.
