# session.ts / turn.ts decomposition plan

Phase 3 of the core systems audit. **Do not refactor for aesthetics** — slice only at invariant boundaries where a dedicated module + contract test reduces risk.

## Current state

| File | Lines | Role |
| --- | ---: | --- |
| [`session.ts`](../../packages/core/src/loop/session.ts) | ~4200 | Session lifecycle, gate-runner closure, REPL turn loop, integration wiring |
| [`turn.ts`](../../packages/core/src/loop/turn.ts) | ~3250 | Tool dispatch, settleGate, escalation, near-green, write accounting |

Behavior is proven piecemeal across ~20 test files. No holistic contract suite covers either megamodule.

## Extraction slices (priority order)

### 1. Gate-runner closure (`session.ts` ~1165–1295)

**Invariant boundary:** FG-1 dirty-package detection, FG-2 stage floor, workspace-container flip floor.

**Target:** `loop/gate-session.ts` (or extend `gate/dirty-packages.ts` + thin session adapter).

**Contract tests:** Session-level test simulating turn-1 shell write vs baseline capture; stage-floor downgrade reds session (extend `gate-redetect.test.ts` patterns).

### 2. Mutation accounting block (`turn.ts` ~810–900)

**Invariant boundary:** `wrote` vs `mutated`, write-guard dispatch, `recordTouched`, re-gate signal.

**Target:** `loop/mutation-accounting.ts` — `runOneToolCall` write accounting extracted; `turn.ts` calls into it.

**Contract tests:** Extend `tool-accounting.test.ts` as the living table (semantic mutation skips write-guard — now covered).

### 3. Review finish hook (`run.ts` ~1286–1325, `repl.ts` reviewAfterGreen)

**Invariant boundary:** Post-green review default-on, scope to turn-touched files, non-fatal errors.

**Target:** `loop/review/post-green.ts` — shared between headless `run.ts` and REPL.

**Contract tests:** `runTask` → `finish()` → review path; REPL `reviewAfterGreen` skip reason on failure.

### 4. Integration capability wiring (`session.ts` ~2353–2416)

**Invariant boundary:** GitHub/Linear/Notion/Sentry caps → tool schema trim.

**Target:** `loop/integration-caps.ts` — resolve caps once, pass to session/tool context.

**Contract tests:** Existing `tools-gating.test.ts`, `policy-integration.test.ts` (integration writes in plan/ci).

## Mutual dependencies to respect

Loop has six mutual-dependency pairs (`agent`, `eval`, `inference`, `render`, `self-harness`, `spec`). New modules must not deepen cycles — prefer `loop/*` importing `gate/*`, `lib/*`, `policy/*`; never `gate` → `loop`.

## Done criteria per slice

1. Extracted module has a behavioral test sibling (house rule).
2. No change to observable harness behavior without a failing-then-passing test.
3. Cyclomatic complexity ≤ 20 per function in new code.
4. `bun run ci:local` green.

## Not in scope

- Splitting `file-ops.ts` (1166 LOC) — adjacent to mutation accounting but stable; revisit only when editing edit primitives.
- Splitting `validate/parse.ts` — separate subsystem; parser fallback work is its own slice.
