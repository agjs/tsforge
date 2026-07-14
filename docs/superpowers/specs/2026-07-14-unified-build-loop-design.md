# Unified Build Loop: One Loop, All Modes — Design

**Goal:** Every build mode — a brownfield `--accept` task, a greenfield feature, a
BoringStack resource, and any scaffold we add later — must flow through **one core
code loop**, so the harness's core features (the escalation ladder R1–R4, the expert
rung, the R5 structured handoff, progress-gated stall detection, checkpoints, the
read-only-spin guard) apply **universally and automatically**. A new mode inherits all
of it for free and can never silently opt out.

**Non-negotiable principle (the whole point):** core capabilities live in exactly ONE
place and are invoked identically by all modes. No mode re-implements, bolts-on, or
bypasses them. If a capability isn't flowing through the shared loop for some mode,
that's the bug — not a thing to patch per-mode.

---

## The problem (grounded)

**The escalation ladder is NOT duplicated.** Both loop drivers — `runTask`
(`loop/run.ts`, used by brownfield + greenfield) and `Session` (`loop/session.ts`,
used by BoringStack) — call the SAME `settleGate` → `checkStuck` → `tryExpertRescue`
primitives in `loop/turn.ts`. R1–R4 + R5 handoff live in exactly one place and both
drivers funnel through it. So the fragmentation is NOT "two loops, one has the ladder."

The fragmentation is narrower and more precise: **the REAL gate is decoupled from the
loop.**

- **Brownfield `--accept`** (`cli.ts` `runOnce` → `runTask`): the real gate (the
  `--accept` command) IS the loop's gate. `settleGate` runs it every cycle, `checkStuck`
  sees the errors, the ladder fires. ✓
- **Greenfield / BoringStack** split the work into `implement(feature)` + a SEPARATE
  `evaluate(feature)`:
  - `implement` runs the model against a **gateless (or TS-only) gate** — BoringStack's
    `Session` is created with `accept: ""` (`headless-build.ts`). An empty gate shells
    `""` → exit 0 → `settleGate` sees "green" → **`checkStuck` has nothing to escalate
    on.** The ladder is present in the loop but **blind**.
  - `evaluate` then runs the AUTHORITATIVE gate (differential validate + judge +
    reachability) **outside any loop**, as a one-shot verdict.
  The greenfield outer loop retries `implement` **identically** on a fail, with the real
  errors never reaching `checkStuck`. The escalation had to be faked at the greenfield
  level (`escalateGuidance`, a bespoke `rescue`) — duplicating what the shared ladder
  already does, but disconnected from it.

**Consequences observed live:**
- The BoringStack notes-app build ground on `sonarjs/no-duplicate-string` (13×) with
  **zero escalations** — the loop's gate was gateless/TS-only, so the ladder never saw
  the lint errors (they lived in the outside `evaluate`).
- A regression (Task 7 rewrite dropped `deps.rescue`) meant features parked **without
  ever consulting the expert** — because the expert (R4) lives in the shared ladder the
  gateless loop never reached, and the greenfield-level copy had a hole.
- Each fix so far has been a **per-mode band-aid** — the opposite of unification.

**The fix, therefore, is not to merge the two drivers** (that would be a large, risky
refactor and would lose Session's long-run features — auto-compaction, per-write lint,
incremental check, adaptive thinking). The fix is to **feed the REAL gate into the ONE
seam both drivers already share (`settleGate`)** so the ladder sees the real errors for
every mode. Future scaffolds then inherit escalation for free.

---

## The unified architecture

**One seam, shared by both drivers: the composed gate, injected at `settleGate`.** The
escalation ladder is already shared (both `runTask` and `Session` call `settleGate` →
`checkStuck`). Make the gate `settleGate` runs an **injected, composable object** rather
than a hardcoded `--accept` shell string, and give every mode its real composed gate.
Both drivers inherit escalation on the real errors — automatically, in one change.

What stays (deliberately — no gratuitous rewrite):

- **Both drivers stay.** `runTask` for brownfield/greenfield; `Session` for BoringStack
  (it needs the long-run features). We do NOT merge them.
- **The existing feature-checklist stays.** `IFeature[]` + `IGreenfieldDeps` +
  `runGreenfield` already are the "list of units + per-unit driver" abstraction, and
  BoringStack already reuses them. No new `IBuildUnit` type migration — the checklist IS
  the unit list. A future scaffold produces the same checklist shape.
- **Freeze-on-green and park-and-revisit stay** — they already work in `runGreenfield`.

What changes:

- **The gate seam (the linchpin, below):** `settleGate`/`runGateStep` run an injected
  `IGate`, defaulting to today's `--accept` command gate (brownfield unchanged).
- **`implement` becomes a pre-step, `evaluate` dissolves into the gate.** The
  deterministic scaffold work (BoringStack generators + wiring + first `db:push`) runs
  ONCE before the model send, as a pre-step. The authoritative check that used to live
  in `evaluate` (differential command + reachability + judge) becomes the **composed gate
  injected into the send**, so it runs INSIDE the loop every cycle and the ladder sees it.
- **The band-aids are deleted:** `escalateGuidance`, `EVAL_STALL_BACKSTOP`, and the
  bespoke greenfield/boringstack `rescue` — the shared ladder (R1–R4 + R5 handoff) now
  does all of it because the live gate is finally inside the loop.

### The gate seam (the linchpin)

**Generalize the loop's gate from an `accept` shell string to an injected gate object.**

```
IGate { run(cwd): Promise<{ passed: boolean; errors: IErrorItem[]; output: string }> }
```

> **Naming (collision resolved):** `gate/types.ts` already exports `IGate = {command,
> label}` — a *descriptor* (banner label + shell command), not a runner. Rename that
> existing type to `IGateSpec` (it is only a command+label pair, few call sites) and give
> the new runner the name `IGate`. The runner is the seam; the spec is just data one
> stage consumes.

`settleGate` calls `gate.run()` instead of only shelling `ctx.task.accept`. Default
`IGate` = run the accept command + parse (today's behavior — brownfield unchanged).
Modes compose richer gates from **stages**.

**A gate is an ordered list of stages, run in series with short-circuit** (review risk
#1 — judge/browser must NOT run every turn). Each stage:

```
IStage { run(cwd): Promise<{ passed: boolean; errors: IErrorItem[]; output: string }> }
```

The composed gate runs stages cheapest-first and **stops at the first failure**, returning
that stage's errors. So the expensive stages (judge = a model call, browser = Playwright)
run ONLY when every cheaper stage is already green — exactly today's `gate → browser →
judge` short-circuit order, now expressed as composition. A stalled unit that can't get
past the command stage never pays for a judge call.

Stages (cheapest → most expensive):

- **command stage** — run tsc/lint/tests (the boringstack `validate && check`). Parses its
  own output → `IErrorItem[]` (today's `validate` parser moves inside this stage).
- **differential stage** — a **wrapper** around another stage (not a peer): it runs the
  inner stage, then suppresses pre-existing baseline failures, surfacing only NEW ones.
  **Baseline lives in the stage's closure** (review risk #2): the driver captures the
  baseline failure-set ONCE at build start and constructs the differential stage closed
  over it — baseline is NOT threaded through `IBuildUnit`/`ILoopCtx`/`ITask`. The gate is
  an object; it carries its own state. This is the boringstack differential logic intact.
- **judge stage** — the reject-by-default model judge. Its prose rejection is adapted into
  a gate error (review risk #4): one `IErrorItem` with `rule: "judge"`, `file` = the
  unit's primary file (so expert-rescue can resolve a file and the fingerprint is stable
  across repeated judge rejections on the same unit), `message` = the critique.
- **browser stage** — render/interaction smoke (when a render target exists); a failure →
  `IErrorItem` with `rule: "browser"`, `file` = the failing route's view.
- **reachability stage** — route/API/i18n wired (boringstack "usable" check).

Because every stage's failures become `IErrorItem`s the loop sees, `checkStuck` detects
stalls on ANY of them (lint, judge, browser, …) and the escalation ladder fires
uniformly — the exact thing that was impossible when the judge/lint lived outside the loop.

**`requireRed` dissolves (review risk #3).** Today greenfield sets `requireRed: false`
because "the global gate is often already green between features" — the shell gate can't
tell that a *feature* is still an unimplemented generic stub, so a green gate at turn 0 is
a false pass. With the composed gate, the **judge/reachability stages make the gate RED
until the feature is actually built** — a generic stub is rejected. So a greenfield unit no
longer starts green, RED-first holds naturally, and the progress guards (tuned for RED
starts) work without special-casing. `requireRed` becomes uniformly true and the
`requireRed: false` crutch is deleted. (If a unit's gate genuinely IS green at turn 0 — all
stages pass — the unit is already done: skip it, no loop needed. The driver's
`if unit.passes: continue` handles that.)

### How each mode injects its gate (the whole change, per mode)

The shared machinery is untouched: `turn → settleGate(gate.run) → checkStuck
(fingerprint + progress guards) → escalate R1→R3 → expert R4 → R5 handoff → checkpoint`,
plus the read-only-spin guard and runaway backstop. Only the gate handed in differs.

- **Brownfield** (`runTask`): default `IGate` = the `--accept` command gate. Unchanged
  behavior — this is the regression anchor.
- **Greenfield** (`runTask` via `greenfieldDeps.implement`): pass the composed gate
  (command + browser + judge) as `opts.gate`; drop `requireRed: false`; delete the
  separate `evaluate` call — the gate now runs inside the send.
- **BoringStack** (`Session` via `boringstackDeps.implement`): create the Session WITH
  the composed gate (command+differential + reachability + judge) instead of gateless;
  `implement` keeps only its deterministic pre-step (generators + wiring + first
  `db:push`), then the send; delete the separate `evaluate`. The per-cycle autofix +
  `db:push` move INTO the command stage (what a dev's save+gate does).

`runGreenfield`'s outer loop (checklist, freeze-on-green, park-on-handoff, revisit)
stays as-is — it already does the right thing. The only change there is deleting the
band-aids: `implement` returns the ladder's handoff (as it already can), and a
non-passing feature parks on that handoff. **Park/handoff now come entirely from the
shared ladder's R5** — `evaluate`, `escalateGuidance`, and `EVAL_STALL_BACKSTOP` are gone.

---

## What this DELETES (fragmentation removed)

- `escalateGuidance` (greenfield band-aid) — the shared steer ladder replaces it.
- The gateless BoringStack `Session` creation — the Session gets the composed gate.
- The separate `evaluate` step — its checks become the composed gate's stages, run inside
  the loop. `IGreenfieldDeps.evaluate` is removed; `implement` keeps only its pre-step.
- Greenfield's ad-hoc stall/backstop (`EVAL_STALL_BACKSTOP`, unchanged-rejection park) —
  the shared progress guards + R5 handoff replace them.
- The bespoke greenfield/boringstack `rescue` wiring — expert is R4 in the shared ladder.
- The `requireRed: false` crutch — the composed gate (judge/reachability stages) is RED
  until the feature is real, so RED-first holds for every mode with no per-mode flag.

---

## Freedom to redesign (no legacy burden)

The harness is in heavy development and **not yet in real use** — so there is **no
backwards-compatibility obligation**. Make the clean, best design and **delete superseded
code freely** (the `implement`/`evaluate` split, `escalateGuidance`, the gateless Session
creation, bespoke backstops). Do NOT add compat shims or preserve old shapes for their own
sake. The one thing that MUST stay behavior-identical is the brownfield `--accept` path
(the default command gate) — it is the regression anchor that proves the gate seam didn't
change existing behavior. Everything else is free to be reshaped for the clean design.

## Migration & risks

- **Gate generalization is the linchpin** — `settleGate`/`runGateStep` call an injected
  `IGate.run()`. The CLI constructs a default command-gate from `--accept`. This is the
  one intrusive core change; do it first (it's a clean refactor, not a compat layer).
- **Judge/browser as gate stages** run model/Playwright calls inside the gate — they're
  slower than a shell gate. The staged short-circuit composition (Seam 2) handles this:
  stages run cheapest-first and stop at the first failure, so judge/browser only run when
  the command stage is already green. Preserve today's order (command → differential →
  browser → judge).
- **Differential-vs-baseline** survives as a stage WRAPPER closed over the build-start
  baseline (Seam 2, risk #2) — it's what stops the model chasing pristine-scaffold
  defects. Do NOT drop it; that's the reason a naive "give the Session the raw gate" fix
  is wrong. Baseline is captured once by the driver and lives in the stage's closure.
- **Session-level optimizations stay put (risk #5).** The interactive Session's
  incremental-TS check and `FULL_GATE_EVERY` (force a full gate after N edits) are speed
  heuristics for per-edit feedback, orthogonal to the gate object. They remain
  Session-level; `FULL_GATE_EVERY` simply points its full-gate call at `gate.run()`
  instead of shelling `accept`. Do not move them onto `IBuildUnit`.
- **DB/env for the gate** (boringstack needs `DATABASE_URL` → isolated Postgres): the
  injected gate carries its own runner/env (the boringstack `Exec`), so this is a
  property of the composed gate, not global — same closure mechanism as the baseline.
- **Checkpoint/handoff already unified** (this session) — they ride the core loop, so
  every mode gets them once it flows through `runTask`.

## Testing (definition of done)

- Brownfield behavior byte-identical (regression suite green).
- A greenfield feature that stalls **escalates through the core ladder and hands off**
  (same assertions as brownfield) — proven with a ScriptedModel, no per-mode escalation.
- A BoringStack resource that stalls on a **lint/judge** failure escalates (the case that
  ground live) — the ladder sees non-TS gate errors.
- One live re-run of the notes-app BoringStack build: it recovers, or climbs the ladder →
  expert → bounded handoff — NOT an identical grind.
- Grep-proof: escalation/handoff/checkpoint have exactly ONE implementation, invoked by
  all modes; no mode re-implements them.

## Docs (part of done, not an afterthought)
The Astro docs (`docs/` site) describe the harness's loop, gate, and build modes. They
MUST be updated to the unified model: one loop, the `IGate`/stages concept, the planner
seam, and the removal of the old greenfield/boringstack split. Stale docs describing the
two-step implement/evaluate path or per-mode behavior must be corrected. Grep the docs
site for the removed concepts and fix every reference.

## Out of scope
- New gate stages beyond those that exist today (just make the existing ones pluggable).
- The planner's internal quality (separate concern).
- Full checkpoint-resume (already phased separately).
