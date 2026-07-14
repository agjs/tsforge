# Relentless Loop: Persistence Over Arbitrary Stoppers — Design

**Goal:** Make the harness relentless. It keeps doing useful work and treats
failure as the **absolute last** action — reached only after every distinct
lever is exhausted — never an early, arbitrary one. The acceptance bar is the
overnight test: you leave a task running, and in the morning it is either still
productively working or it climbed the entire escalation ladder and handed off
with a precise report. It must **never** be idle-failed at 00:10 with the
hardware sitting cold.

**Scope note:** tsforge is a **general brownfield coding agent** — the dominant
use is `tsforge "<task>" --accept "<gate>"` against an existing repo. This design
lives in the **main loop** (`session.ts`/`turn.ts`), codebase-agnostic. Greenfield/
BoringStack is one consumer, not the frame.

---

## The problem

Arbitrary numeric stoppers terminate runs that are still making progress:

- **Turn counts** (`maxTurns: 40`, `webMaxTurns: 400`) are a meaningless unit — a
  Facebook clone might be 15 days, a todo app 50 lines. "Turn 40" measures nothing
  about the work, yet it bounds the `drive(maxTurns)` loop (session.ts:920, 973).
- **Expert cap** (`EXPERT_MAX_USES = 2`, turn.ts:940) parks a run after two expert
  rescues even if each unblocked real progress and the model was still converging.
- **Per-feature count** (`maxAttemptsPerFeature: 3`, greenfield/run.ts) drops a
  feature after 3 evaluate cycles regardless of progress — and bypasses the good
  ladder entirely.
- **Park = terminal fail**, not a resumable handoff — a hard task dies instead of
  checkpointing and surfacing "here's where I'm stuck, here's what I tried."

Same disease as the removed edit-size cap and forced-surgical-edits: an arbitrary
heuristic overriding the real signal, which is **progress**.

---

## What already exists (the good news)

The escalation ladder is ~70% built and general, in `turn.ts`/`steer.ts`/
`expert-handoff.ts`:

- **Progress guards** (`loop.constants.ts`): `samePersist` (a single error surviving
  N cycles), `gateStuckRepeats` (identical error SET N cycles), `noProgressCycles`
  (no new low-water count), plus `plateauGates` + `steerRetrigger` (drive the ladder
  faster under oscillation). Convergence, not turn counts.
- **Steer ladder** (`steer.ts`, `buildSteerMessage(level)` L1 step-back → L2
  investigate + `PLAYBOOKS` → L3 change-strategy). A guard trip escalates `steerLevel`,
  injects `pendingSteer`, and resets the FINE guards but deliberately NOT
  `plateauBest`. Context reset via `essentialMessages` already fires at the top rung
  (`turn.ts:1146`).
- **Expert handoff, already reversible** (`turn.ts:942-945`, invoked from
  `settleGate` right after `checkStuck` at `turn.ts:1320-1327`, and from the
  readonly-spin recovery in `session.ts`): hand the stuck file (`resolveStuckFile`
  surfaces it from type-aware lint) + errors to `capabilities.expert`, apply the fix,
  reset `steerLevel`+guards, and **let the local model continue**. Exactly the
  "expert unblocks → back to local" rung — just with a flat 2-use cap on top.
- **`settleGate` is the single choke point** both `run.ts` and `Session` route
  through — the right central place to make these changes once.

So this is **completing and un-capping an existing ladder**, not a rewrite.

---

## Design: the one termination model

**Keep going while making progress. On a stall, escalate a rung. Fail only when
the ladder is fully exhausted AND still stalled — and "fail" is a resumable
handoff, never a silent quit.**

### The single *task* stop condition — plus a separate crash-guard

A run reaches **handoff** iff **every rung has been tried at the current block AND
the block has not moved** (`gateStuckRepeats`/`samePersist` still tripping after the
top rung). No **arbitrary task-limiting** ceiling: no per-attempt count, no flat
expert cap, no "turn 40 = fail."

**But a hard runaway backstop STAYS** — it is a crash-guard, not a task limiter, and
removing it is unsafe. The interactive loop bounds at `session.ts:1877` and returns
`stuck` at `session.ts:2002`; headless `runTask` hard-stops at `run.ts:433` /
`STUCK_REASON.cap` at `run.ts:532`; **existing tests depend on this** for
never-yielding / read-only / zero-tool-call loops (a genuinely broken agent that
makes no progress and never even calls a tool must still terminate). So:

- Keep a **`runawayBackstopTurns`** — set VERY high (far above any real task), the
  crash-guard. Crossing it is an **anomaly**, logged as such, not a normal fail.
- Add a **separate `checkpointIntervalTurns`** — the repurposed `maxTurns`/
  `webMaxTurns` cadence: at each interval, persist state + emit a progress event, and
  keep going. This is a heartbeat, NOT a terminator.

The task ends on the ladder-exhaustion condition (→ handoff) or the human interrupt.
The backstop only fires on a true no-progress-no-tools bug.

### State the loop must track (new — required before uncapping anything)

Uncapping expert/rungs is unsafe without knowing *which block already got which
lever*, or the same unchanged error set re-triggers a lever forever (expert resets
the guards at `turn.ts:1013`, so a flat-cap removal loops). Add to `ILoopState`:

- **`blockFingerprint`** — a canonical hash of the current stuck error SET (sorted
  rule+location, normalized), so "the same block" is identity, not vibes.
- **`triedLeversByBlock`** — map: fingerprint → set of rungs/levers already applied
  to that exact block. A lever (expert included) is re-enterable **only for a novel
  block**; the block moving = a new fingerprint = the ladder resets naturally.

### Steering is DYNAMIC, not just static content (the backbone)

We cannot pre-author a playbook for every issue on earth — static injection covers
only a handful of *known* patterns and is useless on the long tail (novel logic
bugs, domain-specific stalls). So the ladder's backbone is **dynamic levers that
need no pre-authored content**, applied and then measured against the progress
signal (escalate further only if the block didn't move — they are progress-gated,
not treated as guaranteed unblockers):

- **Reason more** — raise reasoning effort / enable extended thinking on the stalled
  step so the model deliberates before acting. **NEW plumbing:** reasoning is
  provider *config* today, not a per-call option — this needs a per-call reasoning
  override threaded from rung state into `Session.askModel` (`session.ts:1104`).
- **Self-diagnose** — a dedicated reflection turn: the model states what it tried,
  WHY it keeps failing, and a genuinely different hypothesis; **its own output
  becomes the next steer.** Extends the existing `buildSteerMessage(1)` (which only
  injects a fixed string) so the model authors the steering — scales to any issue.
- **Perturb sampling** — raise temperature to escape a local minimum. `proposePlan`
  does this by passing a per-call temp, but the main loop captures temperature ONCE
  (`session.ts:1104`, `run.ts:310`) — so a per-call temp override is **NEW plumbing**,
  the same seam as reasoning.
- **Reset context** — a stuck model is often poisoned by its own failed trail; clear
  the accumulated attempts and re-read fresh. **Already exists** at the top rung
  (`turn.ts:1146`) — reuse, just make it a named rung.
- **Escalate capability** — hand to the expert model (below), gated by fingerprint.

Static rule-`PLAYBOOKS` are demoted to a cheap *shortcut* for known rules, not the
mechanism.

### The rungs (ascending; each entered only after the one below stalls)

Most of the ladder ALREADY EXISTS — `steer.ts:142` maps L1→self-diagnose,
L2→investigate/playbook, L3→change-strategy, and context reset already runs at the
top rung (`turn.ts:1146`). So R1–R3 are **reframe/extend**, not build-from-scratch.
The **genuinely new** work is the two dynamic *call-level* overrides (temperature,
reasoning) + the block-fingerprint state + handoff types + greenfield parked state.

| Rung | Action | Status in repo |
|---|---|---|
| R0 | Refine with the exact gate errors | exists (default) |
| R1 | **Self-diagnose** — reflection turn; model authors its own next steer | **exists** — `buildSteerMessage(1)`, `steer.ts:142`; extend so the model's output feeds forward |
| R2 | **Reason more + perturb** — raise reasoning effort/thinking + temperature; investigate codebase; playbook if a rule matches | steer/playbook **exist**; the temp/reasoning *per-call override* is **NEW** (see below) |
| R3 | **Reset + change direction** — clear the poisoned trail (reset **exists** at `turn.ts:1146`), narrow to the single most-persistent error | reset exists; "narrow" is **new (small)** |
| R4 | **Expert unblock → return to local** — apply expert fix, resume local; re-enterable only for a *novel* block (via fingerprint) | `resolveExpertAsk` **exists**; replace flat `EXPERT_MAX_USES` with fingerprint gate |
| R5 | **Handoff** — checkpoint + structured "stuck on X, tried R1–R4, need …," resumable; the only terminal, never a discard | **NEW plumbing** — result/event types + persistence don't carry this yet |

### Old → new naming (for implementers)

The code today has `steerLevel` L1/L2/L3 + expert; the spec names R0–R5. Map:

| Spec | Today | Change |
|---|---|---|
| R0 | (no steer) refine w/ errors | none |
| R1 | L1 step-back | extend: feed the model's own diagnosis forward |
| R2 | L2 investigate + `PLAYBOOKS` | add per-call temp/reasoning override |
| R3 | (part of L3) change-strategy | add "narrow to one error" (main loop) + park-and-revisit (greenfield driver — see below) |
| R4 | expert handoff | swap flat cap → fingerprint gate |
| R5 | `stuckResult` / park | make it a structured resumable handoff |

**R3 is split deliberately:** "narrow to the single most-persistent error" is a
main-loop steer rung; "park a whole feature and revisit later" is **greenfield
driver behavior** (change #7), not a main-loop rung. Don't conflate them.

### Progress signal / block signature (what "still moving" means)

Reuse the existing `sameErrorSet` logic so it can't be gamed: progress = the **set
of persisting error keys changed** (resolved or genuinely different), not merely a
lower raw count (deleting code lowers the count without progress). That same set of
persisting error keys **IS** the `blockFingerprint` — introduce it once, use it for
both expert-novelty gating and the handoff report. `samePersist`/`gateStuckRepeats`
already encode "the same set persists" — invert for "moved."

---

## Concrete changes (by file)

Ordered so nothing is uncapped before the state that makes uncapping safe exists.

1. **Fingerprint + tried-levers state FIRST** (`turn.ts` `ILoopState`): add
   `blockFingerprint` + `triedLeversByBlock`. Nothing below is safe without it.
2. **Per-call model overrides** (`session.ts` `askModel` at 1104, plumbed through
   `run.ts:310`): allow a per-call `temperature` and `reasoning` override sourced
   from rung state. This is the new seam the dynamic R2 levers ride on.
3. **`turn.ts` — expert re-enters on a NOVEL block, not a count.** Replace the flat
   `EXPERT_MAX_USES` guard (940/967) with "has this `blockFingerprint` already been
   experted?" Keep the post-fix reset (1013) — but it now advances the fingerprint,
   so the same unchanged block can't re-trigger expert forever.
4. **`turn.ts` — extend R1 self-diagnose (feed the model's own diagnosis forward)
   + add R3 "narrow to one error"** (reset already exists at 1146; reuse it). Park
   path becomes R5 handoff, not a bare `stuckResult`.
5. **Structured handoff — types + persistence** (do before relying on it):
   - `loop.types.ts:119` `IRunResult` gains a structured `handoff` (rung history,
     surviving block, the ask) — today it's only status/reason/detail.
   - `greenfield/state.ts:45` `toFeature` currently **drops `lastError` on load** —
     fix the round-trip so a resumed/parked feature carries its surviving block.
6. **Turn cap → backstop + heartbeat, NOT deletion** (`session.ts:1877/2002`,
   `run.ts:433/532`): keep the terminal bound as a HIGH `runawayBackstopTurns`
   crash-guard (tests at `session.test.ts`/`greenfield.test.ts` depend on
   never-yielding loops terminating — do not break them); add a separate
   `checkpointIntervalTurns` heartbeat. Rename/split in `loop.constants.ts`
   accordingly; stall thresholds (`samePersist`/`gateStuckRepeats`/`noProgressCycles`)
   stay as **escalation triggers**.
7. **Greenfield parked STATE, not cap-deletion** (`greenfield/run.ts:72/85`): the
   loop picks the first non-passing feature forever, so removing `maxAttemptsPerFeature`
   without a `parked` status makes a permanently-failing feature loop forever and
   block the rest. Add a `parked` feature status: on ladder-exhaustion a feature
   parks (resumable, carries `lastError`), the driver skips it to build the others,
   then revisits parked features at the end (and retries if a new lever — e.g. expert
   — is now available). Also **wire the result through**: `cli.ts:594` currently
   ignores the `runTask` result, so "greenfield inherits the main ladder" isn't true
   until that's connected.

---

## Edge cases / safety

- **Is this an infinite loop?** No. The ladder is finite; the stop condition is
  "top rung reached AND block unmoved." A zero-progress run climbs R1→R5 and hands
  off — bounded by the number of rungs, not by a turn count.
- **Genuinely impossible task** (gate needs a capability no available model has):
  the ladder exhausts (including expert) and hands off with the specific blocker —
  which is the correct outcome, surfaced, not hidden in a spin.
- **Runaway safety backstop (KEPT, not deleted):** `runawayBackstopTurns` stays as a
  hard crash-guard against a true bug (agent looping with zero tool calls / never
  yielding) — existing tests depend on this terminating. Set very high, far above any
  real task; crossing it is logged as an anomaly, not a normal fail. It is separate
  from `checkpointIntervalTurns` (the heartbeat) and from the ladder (the task logic).
- **User interrupt** stays first-class (Ctrl-C) — relentlessness is not
  un-interruptible.

---

## Testing

- Unit: progress-detection (moved vs stalled set), rung-advance-on-stall,
  expert-re-enterable-on-new-block, park→handoff shape, greenfield park-and-return.
- Loop-level (ScriptedModel / VirtualScreen harness): a scripted model that stalls
  then recovers at rung N proves the loop escalates rather than quits; a model that
  never recovers proves it climbs the full ladder and hands off (does not fail early,
  does not spin forever).
- Definition of done: full `bun run validate` green; a scripted "stall-forever" run
  ends in a bounded handoff (not a turn-count fail, not an infinite loop).

---

## Out of scope (separate passes)

- The runtime e2e smoke tier (`TSFORGE_SMOKE`) — orthogonal.
- Any BoringStack-specific wiring — this is general-loop only.
- Model-capability improvements (better first-shot prompting) — complementary but
  separate.

---

## Decisions (was open; resolved from two expert reviews)

1. **R3 split — DECIDED.** "Narrow to one error" is a main-loop steer rung;
   "park-and-revisit a whole feature" is greenfield-driver behavior (change #7). Not
   the same thing, not conflated.
2. **Heartbeat vs backstop — three constants today, handle each:**
   - `maxTurns: 40` (headless) is the literal "turn 40" that limits tasks — it is
     **too low to be a crash-guard.** It becomes `checkpointIntervalTurns` (heartbeat
     cadence, ~40 is fine), and headless gains a NEW high `runawayBackstopTurns`
     (it has no high bound today — 40 is its only one).
   - `interactiveBackstopTurns: 250` and `webMaxTurns: 400` are already high →
     **repurpose as `runawayBackstopTurns`** (the crash-guard).
   - Never overload one number for heartbeat + backstop.
3. **Turn-cap change is a loop-CONDITION change, not a doc change** (both reviewers
   flagged): `driveInner`'s `for (turn <= maxTurns)` and `run.ts:433` must gain an
   explicit "ladder exhausted for this block AND a stall guard still firing" exit on
   the yield path; the `for`-bound stays only as the runaway crash-guard emitting the
   `cap` anomaly. This + per-turn model-param overrides are the two highest-risk
   mechanical changes — sequence them first and test them hardest.
