# Steering Ladder — the loop steers instead of quitting

## Problem
Today the build loop is a **quitting machine**: `checkStuck` (loop/turn.ts) returns a
terminal `stuck` result after a single (file,rule) persists `samePersist` cycles, or the
error set is unchanged, or no net progress. The run dies and hours of work are discarded.
Traced failure mode: model gets an app ~1–2 errors from green, a style-rule fix needs a
multi-file refactor, it does it imperfectly, then **rewrites the whole file** (via the
`create`-overwrite escape hatch) which re-introduces the fixed error → loops → killed.

The model (DeepSeek-V4-Flash) is capable of getting unblocked **if the harness steers it**
instead of counting to N and killing the run. A build should essentially never hard-fail;
worst case it parks with all work saved.

## Goal
Overnight-autonomous product building: the loop keeps a run alive, escalating help until
the model converges — never discarding progress on a wall it could climb with a nudge.

## The ladder (replaces the terminal returns in `checkStuck`)
Same trip signals as today (a (file,rule) persisting; whole-set unchanged; no net progress),
but each trip **escalates a steer and continues** rather than terminating. A `steerLevel` in
loop state rises; counters reset after each steer so the model gets fresh cycles at the new level.
The ladder is unified — it runs inside `settleGate` in `loop/turn.ts` and fires for every build mode
(boringstack, greenfield, core) via the shared escalation ladder, not per-mode band-aids.

- **Rung 1 — surgical re-anchor.** "This isn't working. STOP rewriting the file. Here is its
  CURRENT content; make a targeted edit to ONLY the flagged line(s)." Enforced by:
  `create` may NOT overwrite an existing file (kills the whole-file-rewrite that undoes progress);
  edit-too-large already rejected; stale anchors already re-fed via `currentFileView`.
- **Rung 2 — rule playbook.** A worked, rule-specific recipe for the known walls
  (`no-restricted-syntax`/as-casts, `no-jsx-computation`, `component-file-purity`, `no-self-import`,
  `max-hooks-per-file`). E.g. jsx-computation → "make src/lib/<x>.ts, export a pure fn, import it."
- **Rung 3 — change strategy.** Roll back to the fewest-errors checkpoint and take a different
  decomposition, or isolate the single failing file and repair it alone.
- **Rung 4 — expert handoff.** Hand the specific failing file + error to a stronger "expert"
  model (configurable endpoint). It returns the fix; harness applies it; **our model continues**
  from there. This is the user's key requirement: don't fail — call in an expert, then resume.
- **Rung 5 — park (never discard).** If even the expert can't, checkpoint the workspace, save
  everything, and surface for human review. No hours-of-work-thrown-away kill.

## Components to build
1. `create` never overwrites an existing file (surgical-edit enforcement). — loop/tools/file-ops.ts
2. Steering state + `steerOrStuck` replacing `checkStuck`'s terminal returns. — loop/turn.ts
3. Steer-message builder (per-level) + rule playbook registry. — new loop/feedback/steer.ts
4. Expert-model handoff (config `expertModel`; scoped fix request; apply; continue). — new module
5. Raise/retire the hard turn cap; convergence bounded by the ladder, then park.

## Testing (real, not mocked)
- Unit: each rung fires at its threshold; playbooks resolve; create-overwrite rejected.
- Live: re-run a previously-stuck app (pm-platform / hospital) against the real endpoint and
  show it now CONVERGES (or reaches the expert rung), instead of dying at turn ~45.
