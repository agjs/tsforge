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

## loop / turn — `src/loop/turn.ts`, `src/loop/session.ts`, `src/loop/loop.types.ts`

Drives a turn: dispatch tool calls, account for writes, re-gate, settle.

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

## tools — `src/loop/tools/*`

Tool handlers + dispatch. Handlers return a `string` (model feedback); mutations are
reported via `ctx.report(ILoopEvent)`, never the return value.

**Invariants**
- Mutating tool ⇒ reports a change (or is in `SPECIAL`: `run`, `yield_status`).
- Mutation events fire ONLY on a real change (empty/no-op ⇒ no event).
- A failure returns a tool-error string — never throws into the loop.
- A tool's text must not lie about state (e.g. "deps installed" when install failed).
- Plan mode: every mutating tool is rejected at dispatch (a salvaged/forced call too).

**Risk areas** silent mutation (the fixed scaffold_web bug); a handler that throws;
optimistic success text; arg parsing that accepts a flag/path injection.

**Checklist** run `tests/tool-accounting.test.ts` (the classification table is the
guard); for each mutating tool confirm the `mutated`-only-on-success path; grep
handlers for `throw` reaching the caller.

## gate / detect-gate — `src/detect-gate.ts`, `src/validate.ts`

Composes the gate command (tsc strict + eslint + opt-in oracles) and the fix/auto-format.

**Invariants** the gate uses tsforge's OWN bundled toolchain (works on any target);
opt-in oracles only join when their env var is set; a failing gate never reports green.

**Risk areas** error-parser fallback dumping a raw blob; opt-in oracle wired in by default.

**Checklist** each opt-in oracle is env-gated; combined parser degrades legibly.

## oracles — `scripts/boot-check.ts`, `src/browser/oracle.ts`, `scripts/*-check.ts`

"Does it RUN / render / stay covered" — failure classes tsc/eslint miss.

**Invariants** opt-in (boot/browser/proptest/coverage gated by env); ephemeral ports
via the shared `serveEphemeral` retry; a browser absence skips, not fails.

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

## rule-packs / meta-rules — `src/rules/*`, packs, `scripts/build-rule-docs.ts`

ESLint rule packs, structural meta-rules, profile gating.

**Invariants** every shipped rule has a doc card and vice versa (parity); type-aware /
profile-gated rules only fire under their profile; meta-rules are change-scoped.

**Checklist** `tests/rule-docs.test.ts` parity; a profile-gated rule is off by default.

## render / CLI — `src/cli.ts`, `src/render/*`

Spinner, pinned status bar, readline REPL, command palette, plan-mode wiring.

**Invariants** nothing writes to the readline input line mid-turn (no inline `\r` while
a prompt is attached); the status bar tears down idempotently on exit/resize/clear;
mid-turn input is queued, not dropped.

**Risk areas** inline spinner clobbering input on a tiny TTY (the fixed P2b); a scroll
region left pinned after exit.

**Checklist** spinner inline gate off in the interactive REPL; teardown on `process.on("exit")`.

## mcp — `src/mcp/*`

Hand-rolled JSON-RPC 2.0 client/server, tool registry.

**Invariants** MCP tools bypass the editable scope + the deterministic gate (external
context, never workspace mutations); a dead server degrades, not crashes.

## web-scaffold — `src/web-templates.ts`, `src/loop/tools/scaffold-*.ts`

Vite/React/vanilla templates, the vendored guard, the web gate.

**Invariants** only `*.gen.ts`/vendored shells are write-guard-exempt; scaffold is
non-destructive (only missing files); a scaffold reports its writes (re-gate).

## lib/fs — `src/lib/fs/process.ts`, fs helpers, `src/lib/scope.ts`

The ONE shared command runner; path normalization; scope checks.

**Invariants** ONE place runs shell commands (gate + `run` both route here) so
cancellation + kill-timeout are uniform; a timeout/abort kills the whole process
group (no leaked `&` child); argv (no-shell) form for any model/content-built command;
a missing binary → exit 127, not a throw.

**Risk areas** kill that leaves grandchildren (the fixed P2a); shell-injection via the
shell form; an uncapped read.

**Checklist** `tests/process.test.ts` group-kill; content-built commands use `runArgvCommand`.

---

## Out-of-scope follow-ups (tracked, not yet built)

- **PTY typing e2e**: a real `node-pty` test that types during a live turn and asserts
  the readline buffer survives. Deferred to avoid a native dep in the stability phase;
  the deterministic spinner-write unit test (`cli.test.ts`) covers the regression.
