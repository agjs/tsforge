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

Today the loop is **fragmented across modes**, and the fragmentation caused every
failure we hit this session:

- **Brownfield `--accept`** (`cli.ts` `runOnce` → `runTask`): the gate is INSIDE the
  loop. `settleGate` → `checkStuck` → escalate → expert → handoff all work. ✓
- **Greenfield / BoringStack** (`loop/greenfield/run.ts`, `loop/boringstack/build.ts`):
  the loop is SPLIT into two decoupled steps —
  - `implement(feature)` runs the model, but for BoringStack the Session is created
    with **no gate** (`headless-build.ts` `Session.create` has no `accept`), so
    `checkStuck`/the escalation ladder **never run during the model's work**;
  - `evaluate(feature)` runs the REAL gate (differential validate + judge + browser +
    reachability) **separately, outside the loop**.
  Because the real gate is outside the loop, the core loop is **blind** — it cannot see
  the errors the model is stuck on, so escalation/handoff/recovery cannot fire. The
  greenfield outer loop then retries `implement` **identically** until a crude backstop,
  with no strategy change and (until a just-shipped stopgap) no expert.

**Consequences observed live:**
- The BoringStack notes-app build ground on `sonarjs/no-duplicate-string` (13×) with
  **zero escalations** — the ladder never saw lint errors (only a TS-only interim check
  is inside the send; lint/meta/judge live in the outside gate).
- A regression (Task 7 rewrite dropped `deps.rescue`) meant features parked **without
  ever consulting the expert**.
- Each fix so far has been a **per-mode band-aid** (e.g. `escalateGuidance` duplicating
  the steer ladder at the greenfield level) — the opposite of unification.

Future scaffolds would inherit this fragmentation.

---

## The unified architecture

A **build unit** is the universal atom. Every mode produces units; every unit runs
through the same core loop.

```
IBuildUnit {
  id: string;
  desc: string;
  scope: string[];        // editable globs (freeze = drop from later units' scope)
  gate: IGate;            // the composed "done" check for THIS unit (see below)
  context?: string;       // planning/domain context injected into the prompt
  seed?: { triedLevers: EscalationRung[] };  // for a revisit (resume, don't re-fire)
}
```

Two — and only two — pluggable seams. Everything else is the shared loop.

### Seam 1 — Planner: goal → units

```
IPlanner { plan(goal, cwd): Promise<IBuildUnit[]> }
```

- **Brownfield:** ONE unit — scope = `--files`/repo, gate = the `--accept` command,
  desc = the task. (This is literally today's `runOnce`, expressed as a 1-unit plan.)
- **Greenfield:** N units, one per feature from the checklist planner.
- **BoringStack:** N units, one per resource from the approved `IProductPlan` slices;
  the deterministic generators + wiring run as a **pre-step** of the unit's build (not a
  separate phase), then the model fills the domain within the loop.
- **Future scaffold:** implements `IPlanner`. Nothing else.

### Seam 2 — Gate: a composed, staged check that runs INSIDE the loop

The core-loop change that makes this possible: **generalize the loop's gate from an
`accept` shell string to an injected `IGate`.**

```
IGate { run(cwd): Promise<{ passed: boolean; errors: IErrorItem[]; output: string }> }
```

`settleGate` calls `gate.run()` instead of only shelling `ctx.task.accept`. Default
`IGate` = run the accept command + parse (today's behavior — brownfield unchanged).
Modes compose richer gates from **stages**, each of which contributes `IErrorItem`s:

- **command stage** — run tsc/lint/tests (the boringstack `validate && check`).
- **differential stage** — wrap another stage; suppress pre-existing baseline failures,
  surface only NEW ones (today's boringstack differential logic, as a wrapper).
- **judge stage** — the reject-by-default model judge → its rejection becomes gate
  errors the loop can see and escalate on.
- **browser stage** — render/interaction smoke (when a render target exists), errors → gate.
- **reachability stage** — route/API/i18n wired (boringstack "usable" check).

Because every stage's failures become `IErrorItem`s the loop sees, `checkStuck` detects
stalls on ANY of them (lint, judge, browser, …) and the escalation ladder fires
uniformly — the exact thing that was impossible when the judge/lint lived outside the loop.

### The shared core loop (unchanged in spirit, now universal)

For each unit: `runTask(task = { scope: unit.scope, gate: unit.gate, context }, opts)`.
Inside, the existing machinery runs for every mode:
`turn → settleGate(gate.run) → checkStuck (fingerprint + progress guards) →
escalate R1→R2→R3 → expert R4 → R5 structured handoff → checkpoint`, plus the
read-only-spin guard and the runaway backstop.

### The thin outer driver (across units) — replaces greenfield/boringstack run loops

```
for each unit (planner order):
  if unit.passes: continue
  result = runTask(unit)                    // the CORE loop — escalation/handoff inside
  if result.done: freeze(unit.scope); continue
  if result.handoff: park(unit, result.handoff)   // handoff comes FROM the core loop
one revisit pass over parked units, seeded with handoff.resume
report done / stuck(parked)
```

Freeze-on-green and park-and-revisit stay (they're good), but **park/handoff now come
from the core loop's R5**, not a bolted-on greenfield mechanism.

---

## What this DELETES (fragmentation removed)

- `escalateGuidance` (greenfield band-aid) — the core steer ladder replaces it.
- The gateless BoringStack `Session` — the Session gets the composed `IGate`.
- The separate `evaluate` step and `IGreenfieldDeps.implement/evaluate` split — folded
  into one `runTask(unit)` whose gate is the composed gate.
- Greenfield's ad-hoc stall/backstop (`EVAL_STALL_BACKSTOP`, unchanged-rejection park) —
  the core progress guards + R5 handoff replace them.
- The bespoke greenfield `rescue` wiring — expert is R4 in the core ladder.

---

## Freedom to redesign (no legacy burden)

The harness is in heavy development and **not yet in real use** — so there is **no
backwards-compatibility obligation**. Make the clean, best design and **delete superseded
code freely** (the old greenfield/boringstack split, `escalateGuidance`, the gateless
Session, bespoke backstops). Do NOT add compat shims or preserve old shapes for their own
sake. "Simple runs keep working" means the brownfield path still *functions*, not that it
must be byte-identical — reshape it into a clean 1-unit plan if that's cleaner.

## Migration & risks

- **Gate generalization is the linchpin** — `settleGate`/`runGateStep` call an injected
  `IGate.run()`. The CLI constructs a default command-gate from `--accept`. This is the
  one intrusive core change; do it first (it's a clean refactor, not a compat layer).
- **Judge/browser as gate stages** run model/Playwright calls inside the gate — they're
  slower than a shell gate; run them as the FINAL stages (only when the cheaper stages
  are green) to avoid paying for them every cycle. Preserve today's short-circuit order
  (gate → browser → judge).
- **Differential-vs-baseline** must survive as a stage wrapper (it's what stops the model
  chasing pristine-scaffold defects — do NOT drop it, the reason a naive "give the
  Session the raw gate" fix is wrong).
- **DB/env for the gate** (boringstack needs `DATABASE_URL` → isolated Postgres): the
  injected gate carries its own runner/env (the boringstack `Exec`), so this is a
  property of the composed gate, not global.
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
