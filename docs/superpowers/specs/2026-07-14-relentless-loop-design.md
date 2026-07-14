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
  (no new low-water error count for N cycles). Convergence, not turn counts.
- **Steer ladder** (`steer.ts`, `buildSteerMessage(level)` L1 step-back → L2
  investigate → L3 rule-playbook via `PLAYBOOKS` keyed by lint rule). A guard trip
  escalates a rung and resets the guards so the model gets fresh cycles at a more
  directive steer (turn.ts:304-306).
- **Expert handoff, already reversible** (turn.ts:942-945): before a stalled park,
  hand the stuck file + errors to `capabilities.expert`, apply its fix, and **let
  the primary (local) model continue**. This is exactly the "expert unblocks, then
  switch back to local" rung — it just has a flat 2-use cap on top.

So this is **completing and un-capping an existing ladder**, not a rewrite.

---

## Design: the one termination model

**Keep going while making progress. On a stall, escalate a rung. Fail only when
the ladder is fully exhausted AND still stalled — and "fail" is a resumable
handoff, never a silent quit.**

### The single stop condition

A run stops iff **every rung has been tried at the current block AND the block
has not moved** (`gateStuckRepeats`/`samePersist` still tripping after the top
rung). There is **no turn ceiling, no attempt ceiling, no flat expert ceiling.**

### Steering is DYNAMIC, not just static content (the backbone)

We cannot pre-author a playbook for every issue on earth — static injection covers
only a handful of *known* patterns and is useless on the long tail (novel logic
bugs, domain-specific stalls). So the ladder's backbone is **dynamic levers that
need no pre-authored content**, applied and then measured against the progress
signal (escalate further only if the block didn't move — they are progress-gated,
not treated as guaranteed unblockers):

- **Reason more** — raise reasoning effort / enable extended thinking on the stalled
  step so the model deliberates before acting. Model-agnostic, zero static content;
  tsforge reasoning is configurable per model, so escalation raises it.
- **Self-diagnose** — a dedicated reflection turn: the model states what it tried,
  WHY it keeps failing, and a genuinely different hypothesis; **its own output
  becomes the next steer.** The dynamic generalization of a fixed "step back" string
  — it scales to any issue because the model authors the steering.
- **Perturb sampling** — raise temperature to escape a local minimum (already used
  in `proposePlan`'s retry).
- **Reset context** — a stuck model is often poisoned by its own failed trail; clear
  the accumulated attempts and re-read the relevant files fresh.
- **Escalate capability** — hand to the expert model (below).

Static rule-`PLAYBOOKS` are demoted to a cheap *shortcut* for known rules, not the
mechanism.

### The rungs (ascending; each entered only after the one below stalls)

| Rung | Action | Kind | Reuses |
|---|---|---|---|
| R0 | Refine with the exact gate errors | — | current default |
| R1 | **Self-diagnose** — reflection turn; model authors its own next steer (falls back to `buildSteerMessage(1)` framing) | dynamic | `buildSteerMessage(1)` as scaffold |
| R2 | **Reason more + perturb** — raise reasoning effort / thinking, bump temperature; investigate the codebase (read neighbors, grep the established pattern); inject a rule playbook IF one matches | dynamic (+static shortcut) | reasoning config, temp, `PLAYBOOKS` |
| R3 | **Reset + change direction** — clear the poisoned trail, re-read fresh; narrow to the single most-persistent error; if a whole feature/unit is wedged, **park it and move to other work, revisit later** | dynamic | new (small) |
| R4 | **Expert unblock → return to local** — hand the stuck file+errors to the expert model, apply its fix, resume the local model. Reversible; re-enterable for each *new* block | capability | `resolveExpertAsk` (uncap it) |
| R5 | **Handoff** — checkpoint + precise "stuck on X, tried R1–R4, need you / a stronger model / more context," resumable. The only true terminal, and it is not a discard | — | greenfield state is already persisted |

### Progress signal (what "still moving" means)

Reuse the existing definition so it can't be gamed: progress = the **stuck error
set changed** (errors resolved or genuinely different), not merely a lower raw
count (deleting code lowers the count without progress). `samePersist`/
`gateStuckRepeats` already encode "the same set persists" — invert that for "moved."

---

## Concrete changes (by file)

1. **`session.ts` — turn cap is no longer a hard fail.** The `drive(maxTurns)`
   bound (session.ts:920, 973) becomes a **checkpoint/heartbeat interval**, not a
   terminator: at each interval, persist state + optionally emit a progress event,
   then keep going as long as progress-or-escalation is happening. The loop ends on
   the single stop condition above, not on a turn number.
2. **`turn.ts` — remove `EXPERT_MAX_USES` flat cap** (turn.ts:940, 967). Gate the
   expert on **novelty of the block** instead: don't re-expert an unchanged error
   set (pointless), but allow it freely for each *new* stuck block. After each
   expert fix, the local model continues (already does).
3. **`turn.ts` — add R3 (change-direction / narrow) between L3 and expert**, and
   make the park path R5 (handoff), not a bare `stuckResult`.
4. **`turn.ts`/`session.ts` — park → resumable handoff.** `stuckResult` becomes a
   checkpoint + structured report (rung history, the surviving block, the ask).
   Resumable on a later invocation or when a new lever is configured.
5. **`greenfield/run.ts` — delete `maxAttemptsPerFeature`.** The per-feature loop
   inherits the main ladder + progress signal. Add **park-and-return**: a wedged
   feature parks (resumable), the driver builds the others, then revisits parked
   features (and re-tries them if a new lever — e.g. an expert model — is available).
6. **`loop.constants.ts`** — the stall thresholds (`samePersist`/`gateStuckRepeats`/
   `noProgressCycles`) stay as **escalation triggers**; `maxTurns`/`webMaxTurns`
   become the heartbeat interval (documented as such); `maxAttemptsPerFeature`
   removed.

---

## Edge cases / safety

- **Is this an infinite loop?** No. The ladder is finite; the stop condition is
  "top rung reached AND block unmoved." A zero-progress run climbs R1→R5 and hands
  off — bounded by the number of rungs, not by a turn count.
- **Genuinely impossible task** (gate needs a capability no available model has):
  the ladder exhausts (including expert) and hands off with the specific blocker —
  which is the correct outcome, surfaced, not hidden in a spin.
- **Runaway safety backstop:** a single *hard* ceiling remains, set very high and
  **only** as a crash-guard against a true bug (e.g. an agent looping with zero tool
  calls) — not a task limiter. Crossing it is logged as an anomaly, not a normal fail.
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

## Open decisions (small; most answered by direction)

1. **R3 "narrow to one error"** — worth building, or go R2→expert directly? (Adds
   value on multi-error stalls; small.)
2. **Heartbeat interval value** for checkpoint/report — start at the current
   `maxTurns`/`webMaxTurns` numbers repurposed as intervals? (No behavioral cost;
   just cadence of persistence + progress events.)
