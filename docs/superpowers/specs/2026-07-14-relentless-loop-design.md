# Relentless Loop: Persistence Over Arbitrary Stoppers — Design

**Goal:** Make the harness relentless. It keeps doing useful work and treats
failure as the **absolute last** action — reached only after every distinct lever
is exhausted — never an early, arbitrary one. Remove the arbitrary numeric stoppers
(`maxTurns`, `EXPERT_MAX_USES`, `maxAttemptsPerFeature`) and replace them with a
progress-gated escalation ladder whose only terminal state is a structured,
resumable **R5 handoff**. Success bar = the overnight test: you leave a task running
and in the morning it is either still productively working or it climbed the entire
ladder and handed off cleanly — never idle-failed at 00:10 with the hardware cold.

**Scope:** tsforge is a **general brownfield coding agent** — the dominant use is
`tsforge "<task>" --accept "<gate>"` against an existing repo. This design lives in
the **main loop** (`session.ts`/`turn.ts`/`run.ts`), codebase-agnostic. Greenfield/
BoringStack is one consumer, not the frame.

---

## The problem

Arbitrary numeric stoppers terminate runs that are still making progress:

- **Turn counts** — `maxTurns: 40` (headless), `interactiveBackstopTurns: 250`,
  `webMaxTurns: 400`. "Turn 40" measures nothing about the work (a Facebook clone is
  15 days; a todo app is 50 lines), yet it bounds the `for (turn <= maxTurns)` loops
  in `session.ts:driveInner` and `run.ts:433` and emits `STUCK_REASON.cap`.
- **Expert cap** — `EXPERT_MAX_USES = 2` (`turn.ts:940`) parks a run after two expert
  rescues even if each unblocked real progress.
- **Per-feature count** — `maxAttemptsPerFeature: 3` (`greenfield/run.ts`) drops a
  feature after 3 evaluate cycles regardless of progress, bypassing the good ladder.
- **Park = terminal fail**, not a resumable handoff.

Same disease as the removed edit-size cap and forced-surgical-edits: an arbitrary
heuristic overriding the real signal, which is **progress**.

---

## What already exists (grounded)

The ladder is ~70% built and general:

- **Progress guards** (`loop.constants.ts`, applied in `turn.ts:checkStuck`):
  `samePersist` (a single error key surviving N cycles), `gateStuckRepeats`
  (identical error SET N cycles), `noProgressCycles` (no new low-water count),
  `plateauGates` + `steerRetrigger` (drive the ladder faster under oscillation).
- **Steer ladder** (`steer.ts` `buildSteerMessage(level)`): L1 step-back → L2
  investigate + `PLAYBOOKS` → L3 change-strategy. `checkStuck` does
  `state.steerLevel += 1`, injects `pendingSteer`, resets the FINE guards but NOT
  `plateauBest`. Context reset via `essentialMessages` fires at the top rung
  (`turn.ts:1146`).
- **Expert handoff** (`tryExpertRescue`, `turn.ts:942`): invoked from `settleGate`
  right after `checkStuck` returns a stalled result when `steerLevel > STEER_LADDER_MAX`
  (`turn.ts:1320-1327`), and from the read-only-spin recovery in `session.ts`. Applies
  the expert's fix, resets `steerLevel = 0` + guards, and the local model continues —
  already reversible. Just capped at 2 uses.
- **`settleGate`** is the main gate-stall path both `run.ts` and `Session` route
  through — but NOT the only terminal exit (see the exit table below).
- Error keys are `${file}:${ruleId}` on the meta-rule path (`turn.ts:1258`); regular
  parsers may include a line (`file:line:rule`). `fingerprintFor` uses whatever keys
  actually exist in `IErrorItem`, so the exact format is not a correctness concern —
  `trackErrorAges`/`samePersist` already operate per-key.

So this is **completing + un-capping + making handoff first-class**, not a rewrite.

---

## Termination model

**Keep going while making progress. On a stall, escalate a rung. The only task
terminal is R5 handoff, reached when the ladder is exhausted for the current block
AND the block has not moved. A high crash-guard remains, separate from task logic.**

- **No arbitrary task ceiling:** no per-attempt count, no flat expert cap, no
  "turn 40 = fail."
- **Runaway crash-guard KEPT:** a high `runawayBackstopTurns` terminates a genuinely
  broken agent (never-yielding / zero-tool-call). Existing tests depend on this. It
  fires as an **anomaly** (logged as such), not a normal fail.
- **Heartbeat, separate:** `checkpointIntervalTurns` persists a checkpoint + emits a
  progress event on a cadence; it does NOT terminate.

---

## State the loop must track (new — build FIRST)

Uncapping a lever without knowing *which block already got it* re-triggers it
forever (expert resets guards at `turn.ts:1013`). Add to `ILoopState` (in `turn.ts`):

- **`blockFingerprint: string`** — canonical identity of the current stuck block,
  **guard-specific** (NOT the raw error set — `sameErrorSet`, `validate/errors.ts:26`,
  treats a lateral rotation as "moved", but `plateauGates` exists because rotation is
  often non-progress). Derived from the guard that fired:

  ```
  fingerprintFor(state): string
    if samePersist fired      → the single persisted key from trackErrorAges
                                  (e.g. "src/x.ts:no-unsafe-argument")
    else if gateStuckRepeats  → sorted-join of the current error keys
    else if plateau/no-new-low→ `${lowWaterCount}|${sorted recurring rule keys
                                  over recentGateFingerprints}`  (NOT the momentary set)
    else                      → "" (no active block)
  ```
  Must be a stable string usable as a `Map` key. Ship as a pure, unit-tested helper.

- **`recentGateFingerprints: string[]`** (ring buffer, len = the oscillation window)
  — **NEW state** (`turn.ts:328` today has only `redGates`/`plateauBest`, not the
  per-gate key-set history). The plateau branch of `fingerprintFor` needs it to
  compute "recurring rule keys over the window"; without it that branch can't be
  implemented. Push the sorted key-set each gate cycle.

- **`triedLeversByBlock: Map<fingerprint, Set<Rung>>`** — which rungs have been
  applied to that exact block. A lever counts as "tried" once its escalation turn
  **completes AND the next gate shows the block unmoved** (entering isn't enough).
  Re-applied **only for a novel fingerprint**. Genuine progress → new fingerprint →
  no entry → the ladder restarts at R1.

- **`pendingRung: Rung | null` + `pendingBlockFingerprint: string | null`** — **NEW
  state, required for the "record after next gate" rule.** When a rung is applied,
  stash it here with the fingerprint it was applied to; on the NEXT gate,
  `settleGate` reads them back — if the recomputed fingerprint equals
  `pendingBlockFingerprint`, record `pendingRung` into `triedLeversByBlock` (block
  unmoved → lever failed); either way clear the pending pair. Without this, the loop
  has no memory across the gate boundary of which lever it just tested.

- **Synthetic fingerprints for non-gate exits** — some terminal exits (timeout,
  degeneration, malformed tool call, read-only spin) have **no gate error set**, so
  `fingerprintFor` can't derive from errors. Define synthetic keys so these blocks are
  still identity-tracked and can climb/record: `timeout:<normalized error>`,
  `degeneration:<task>`, `malformed-tool-call`, `readonly-spin:<lastGateBlock|no-gate>`.

- **`pendingDiagnosisSteer: string | null`** — **R1 is two-phase and must NOT be
  recorded on its diagnosis cycle.** The generic "record `pendingRung` if next gate
  unmoved" rule would wrongly mark R1 tried after the diagnosis-only cycle (before the
  model acts on its own diagnosis). So R1's first cycle is a diagnosis capture that
  sets `pendingDiagnosisSteer` and does NOT set `pendingRung`; only the SECOND cycle
  (act-on-diagnosis) sets `pendingRung = R1`, so R1 is recorded tried only if the
  block is still unmoved after the model acted. See the R1 mechanic.

**State-machine semantics (replaces the scalar-only `steerLevel`):** keep
`steerLevel` as a **purely cosmetic** display/order index only — once
`blockFingerprint` + `triedLeversByBlock` exist they are the **single source of
truth** for what to escalate; no logic may branch on `steerLevel`. Gate escalation on
`triedLeversByBlock[fingerprint]`. On a stall: pick the **lowest rung not yet tried
for this fingerprint**; apply it; record it. When all rungs (through expert) are in
the set for the current fingerprint → **R5 handoff**. After an expert fix, if the
fingerprint is unchanged on the next stall, do **not** re-climb from R1 — expert is
already recorded for that block, so the next unfilled rung (or R5) is next. If the
fingerprint changed, start fresh.

**Recording hook (explicit):** the record happens in `settleGate` — after a
steer-injected cycle runs and the next gate is evaluated, if the recomputed
`blockFingerprint` is unchanged, add the rung just applied to
`triedLeversByBlock[fingerprint]`. If it changed, the new fingerprint has no entry
and the ladder restarts naturally. This is the single place "tried" is written.

---

## Steering is DYNAMIC, not just static content (the backbone)

We cannot pre-author a playbook for every issue — static injection covers only known
patterns. The backbone is dynamic, content-free levers, each **progress-gated** (apply,
measure against the block signature, escalate only if the block didn't move):

- **Self-diagnose (R1)** — a reflection turn: the model states what it tried, WHY it
  keeps failing, a genuinely different hypothesis; **its own output becomes the next
  steer.** Content-free, provider-agnostic → the **most reliable dynamic lever on the
  local DeepSeek model** (see reason-more caveat). Extends `buildSteerMessage(1)`.
- **Reason more (R2)** — raise reasoning effort/thinking. **Provider-capability-aware
  + NEW plumbing:** reasoning is provider *config* today (`request.ts:71`) and
  **DeepSeek pins thinking mode per-conversation** (`openai-compatible.ts:40`), so a
  per-turn flip may not be honored without a conversation restart → on DeepSeek this
  **no-ops cleanly** and the ladder leans on R1/R3. Best-effort by provider.
- **Perturb sampling (R2)** — raise temperature. Provider-aware: OpenAI-style requests
  **omit temperature** (`request.ts:181`); the main loop captures temp ONCE
  (`session.ts` askModel path, `run.ts:310`). Per-call override is NEW plumbing.
- **Investigate + playbook (R2)** — read neighbors / grep the established pattern;
  inject the rule `PLAYBOOK` IF one matches (a cheap shortcut for known rules, NOT the
  mechanism).
- **Reset + narrow (R3)** — context reset already exists (`turn.ts:1146`); "narrow"
  is new (below).
- **Expert (R4)** — hand to the expert model, apply fix, resume local; gated on a
  novel fingerprint.

---

## The rungs

| Rung | Action | Status |
|---|---|---|
| R0 | Refine with the exact gate errors | exists (default) |
| R1 | **Self-diagnose** — model authors its own next steer | extend `buildSteerMessage(1)` — feed output forward (see mechanics) |
| R2 | **Reason-more + perturb + investigate/playbook** — best-effort per-call reasoning/temp override; steer + `PLAYBOOKS` | steer/playbook exist; per-call override is **NEW** |
| R3 | **Reset + narrow** — reset the poisoned trail (`turn.ts:1146`), then narrow to the single most-persistent error | reset exists; "narrow" is **new (small)** |
| R4 | **Expert unblock → return to local** — apply fix, resume local; novel-fingerprint gated | `tryExpertRescue` exists; replace flat `EXPERT_MAX_USES` |
| R5 | **Handoff** — structured, resumable "stuck on X, tried R1–R4, need …"; the ONLY terminal, never a discard | **NEW** types + persistence |

**Old → new mapping:** today `steerLevel` L1/L2/L3 + expert → R1/R2/R3 + R4; `stuckResult`/park → R5.

### R1 mechanic (self-diagnose feeds forward) — concrete

R1 is **two-phase** and must NOT be recorded as tried on its diagnosis cycle (or it's
marked failed before the model ever acts on its own diagnosis):

1. **Phase A (diagnose):** on the first stall at a block, inject the R1 steer
   (`buildSteerMessage(1)`: "diagnose your loop; different approach"). Set
   `pendingDiagnosisSteer`; **do NOT set `pendingRung`** — this cycle is not recorded.
2. **Capture the diagnosis** — a model response is atomic (`IModelResponse` has
   `content` + `toolCalls`, `inference.types.ts:33`), so capture **`res.content` from
   the turn that follows the R1 steer.** Trivial/empty (< N chars, or restates the
   error) → mark R1 tried and escalate to R2 (skip Phase B).
3. **Phase B (act):** next cycle, set `pendingSteer` to a block quoting it — *"Your
   own diagnosis last cycle: «…». Act on that different approach now; don't repeat
   what you tried."* — AND now set `pendingRung = R1`. So R1 is recorded tried only if
   the block is still unmoved after the model *acted* on its diagnosis.
4. Clear `pendingDiagnosisSteer` once Phase B runs (or on escalate).

### R3 "narrow" mechanic — concrete

Not just stronger wording. For the R3 cycle, **filter the gate feedback shown to the
model** down to the single most-persistent error (the `samePersist` key). `focusError`
**lives in `ILoopState`** (a single key string, or null): set on R3 entry, **cleared
the moment the block fingerprint moves**, and **consumed by `injectFeedback` AND the
lower-level `gateFeedback` construction** (the filter must reach the actual feedback
string handed to the model, not just the top-level inject). Critically, `gateFeedback`
renders regular `errors` and `metaViolations` **separately**
(`feedback/feedback.ts:35/77`), so `focusError` must filter **BOTH arrays** — using a
meta key `${file}:${ruleId}` for `IMetaRuleViolation` — or a persistent meta-rule
can't be focused and the model still gets the full project-structure wall. This
shrinks the surface the model must reason about when a broad error list is thrashing.

---

## Terminal-exit classification (every stuck exit, decided)

R5 handoff must replace old terminal fails at EVERY exit, not just `stuckResult`.

| Exit | Location | New behavior |
|---|---|---|
| Gate stall (via `checkStuck`) | `settleGate`, `turn.ts:1320` | **Escalate** the ladder; R5 handoff only at exhaustion |
| Build-nudge exhaustion | `session.ts:1213` | **R5 handoff** (was terminal) |
| Degeneration budget | `session.ts:1254` | **R5 handoff** |
| Repeated timeout | `session.ts:1300` | **R5 handoff** (network/tooling — surface, resumable) |
| Read-only spin | `session.ts:1792` | **Escalate** (feed "you keep reading, act") then R5; keep guard |
| Interactive final backstop | `session.ts:1877/2002` | **Anomaly** — keep as `runawayBackstopTurns` crash-guard |
| Headless degeneration/cap | `run.ts:491/544` | Degeneration → **R5 handoff**; cap → **anomaly** backstop |
| Headless read-only spin | `run.ts:501/529` (NO guard today) | **ADD** the interactive read-only guard, then escalate/R5 |

**Non-gate exits need their own settle/record path.** The generic "record `pendingRung`
in `settleGate` when the next gate is unmoved" rule assumes a next gate — but timeout,
degeneration, malformed-tool-call, and read-only spin **do not necessarily reach one**,
so `pendingRung` would never be recorded and the block couldn't climb or hand off.
Add a shared **`settleSyntheticBlock(state, syntheticFingerprint)`** that mirrors
`settleGate`'s record-and-escalate for these exits: compute the synthetic fingerprint,
record the tried lever if unchanged, pick the next rung or R5. Every exit above routes
through either `settleGate` (has errors) or `settleSyntheticBlock` (no errors).

---

## `IRunResult` + handoff shape

`IRunResult` (`loop.types.ts:119`) today has `task/redConfirmed/status/cycles/reason/
detail/edits/regressions`. Add:

```ts
handoff?: {
  block: string;              // the surviving blockFingerprint
  rungHistory: Rung[];        // ordered levers tried on the final block
  errors: string[];          // the persisting error keys/messages
  ask: string;               // what a human / stronger model / more context is needed for
  resumable: true;
  // Machine state to resume WITHOUT re-firing the same levers. `rungHistory` is for
  // humans; this is for the loop. Either the serialized tried-levers for the final
  // block, or a ref to the checkpoint that holds full ILoopState.
  resume: { triedLevers: Rung[] } | { checkpointRef: string };
}
```

The `resume` field is what closes the greenfield revisit loop — `rungHistory`/`errors`
are human-facing; **`resume` is the machine state a second pass seeds** so it doesn't
re-run the same levers from scratch. Without it, `IHandoff` can't fulfill the
greenfield "seed saved `triedLeversByBlock`" promise.

Keep `status: "stuck"` (a handoff is a kind of stuck), but a handoff is distinguished
by `handoff !== undefined`. Add `STUCK_REASON.handoff` alongside `.stalled`/`.cap`
(`.cap` stays for the anomaly backstop only). The final handoff report is emitted as a
rich event and rendered in CLI output; it lists **which levers were tried** for the
final block (observability for post-mortems).

The `ask` string is populated by a small **pure helper `buildHandoffAsk(finalSteer,
persistingErrors)`** that derives the "what a human / stronger model / more context is
needed for" text from the last steer message + the surviving error set — so `ask` has
a clear owner and is unit-testable, not free-form.

---

## Concrete changes (by file) — safety-first order

1. **Fingerprint state + tests** — `turn.ts`: `ILoopState.blockFingerprint` +
   `triedLeversByBlock`, the `fingerprintFor` helper (implement it **next to
   `trackErrorAges`/`checkStuck` in `turn.ts` and unit-test it in isolation** — it's
   the highest-risk piece), and the escalation state-machine. Tests prove oscillation
   ≠ novel block. Nothing below is safe first.
2. **Headless read-only-spin guard** — `run.ts`: port the interactive
   `readonlySpinStop` so read-only turns can't burn the (about-to-be-raised) backstop.
3. **Structured handoff — types, persistence, all exits** — `loop.types.ts` (`handoff`
   field + `STUCK_REASON.handoff`); the pure **`buildHandoffAsk(finalSteer,
   persistingErrors)`** helper (unit-tested) that populates `handoff.ask`; convert the
   bypass exits per the table; fix `greenfield/state.ts:45` `toFeature` **dropping
   `lastError`** on load.
4. **Expert re-enters on novel block** — `turn.ts:940/967`: replace `EXPERT_MAX_USES`
   with the `triedLeversByBlock` novelty gate.
5. **Dynamic levers** — R1 feed-forward (capture assistant diagnosis → `pendingSteer`);
   R2 per-call `temperature`/`reasoning` overrides threaded through `askModel`
   (`session.ts:1070`) → `acquireResponse` (`session.ts:1336`) and the `run.ts:310`
   capture, **best-effort per provider, no-op where unsupported**, and **auxiliary
   calls (planning, judge, compaction, expert) stay on defaults**; R3 narrow
   (`injectFeedback` filter + `focusError`).
6. **Heartbeat + backstop split** — `loop.constants.ts`: `maxTurns:40` →
   `checkpointIntervalTurns` + a NEW high `runawayBackstopTurns` for headless;
   repurpose `interactiveBackstopTurns:250`/`webMaxTurns:400` as the backstop. Loop
   CONDITION change in `driveInner`/`run.ts:433`: normal terminal is ladder-exhaustion;
   the `for`-bound remains only as the crash-guard. Add checkpoint emission.
   **Public-surface compatibility (decide explicitly):** `maxTurns` is exposed on the
   CLI (`cli/args.ts:85`, forwarded `cli.ts:117`), the recipe schema
   (`config/recipes.ts:37`), and run options (`loop.types.ts:144`) — where it behaves
   as a hard task cap today. **Decision: a user-supplied `maxTurns` maps to
   `runawayBackstopTurns` (the crash-guard), NOT a task cap**, so old recipes stop
   silently limiting tasks; document the semantics change and keep the name (alias) to
   avoid breaking configs. `checkpointIntervalTurns` is a separate new option.
7. **Greenfield parked state (an API change, not a constant deletion)** — `greenfield/`:
   - **`IGreenfieldDeps.implement` must change signature** — it returns
     `Promise<void>` today (`greenfield/run.ts`), so the driver CANNOT see the inner
     run's `handoff`. Change it to return an implementation result
     (`{ handoff?: IHandoff }`), and add an input so prior handoff/tried-lever state
     can be **seeded into a retry** (so a second-pass revisit resumes rather than
     re-running fresh). Both consumers ignore the inner result today and must be
     updated: CLI `greenfieldDeps.implement` → `runTask` (`cli.ts:594`) and
     BoringStack → `host.send` (`build.ts:243`).
   - `IFeature`: add `status: "open" | "passing" | "parked"` + carry `handoff`.
     Round-trip `lastError` + handoff in `state.ts`.
   - `greenfield/run.ts`: consume the returned handoff to detect ladder exhaustion;
     delete `maxAttemptsPerFeature`; on exhaustion **park + skip**, so a wedged
     feature never blocks the rest. **Revisit = a simple two-pass:** after the main
     pass over open features, do **one** second pass over parked features, **seeding
     each with its saved `triedLeversByBlock`** so the revisit doesn't immediately
     re-fire the same levers on the same block; report fully-stuck only if features
     remain parked after that pass.

### Checkpoint payload (concrete)

The heartbeat (and pre-handoff) writes a **compact snapshot** under
`.tsforge/checkpoints/`: **compacted messages, full `ILoopState` (incl. `steerLevel`,
`triedLeversByBlock`, `blockFingerprint`, `focusError`, `recentGateFingerprints`),
rung history, the gate command + last gate output, and the editable scope.**
**`ILoopState` cannot be `JSON.stringify`'d raw** — it holds `Map`/`Set` fields
(`errorAge`, `pushedGuides`, the new `triedLeversByBlock`; `turn.ts:298`), which JSON
flattens to `{}`. Ship **`serializeLoopState`/`deserializeLoopState` DTO helpers**
(Map→entries[], Set→array) as part of the checkpoint work, before anything writes a
checkpoint. For non-greenfield tasks this
snapshot is new (headless has event logs but no resumable loop state today;
interactive only persists via the session's post-send persistence). **Phasing:** ship
the snapshot write + a clean handoff report first; **full conversation resume can be
phased in later** — the immediate win is that the run never idle-fails and the handoff
is actionable, not that every run is instantly re-runnable.

---

## Edge cases / safety

- **Infinite loop?** No — the ladder is finite; the terminal is "all rungs tried for
  this fingerprint AND unmoved" → R5. Bounded by rungs, not turns.
- **Impossible task** (needs a capability no model has): ladder exhausts (incl.
  expert), R5 hands off with the specific blocker — surfaced, not hidden.
- **Runaway crash-guard KEPT** — `runawayBackstopTurns`, high, anomaly-logged; guards
  zero-tool / never-yield bugs; tests depend on it terminating.
- **User interrupt** (Ctrl-C) stays first-class — relentless ≠ un-interruptible.
- **Cost/observability** — long relentless runs stress context compaction + cost; the
  heartbeat + rich handoff report mitigate; every final handoff logs the levers tried.

---

## Testing

**Existing tests to expect to touch / keep green:** `settle-steps`, `repair-loop`,
`expert-rescue`, `greenfield.test`, `session.test`, `session-e2e-hunt` (focused suite:
74 pass today — the baseline). The `EXPERT_MAX_USES`, `maxAttemptsPerFeature`, and
turn-cap assertions will change; the never-yielding-loop / runaway-backstop coverage
MUST stay.

**New tests required:**
- `fingerprintFor` stability: rotating/oscillating error set → **same fingerprint**
  (not novel); genuine resolution → new fingerprint.
- lever-not-reapplied-to-same-block (esp. expert): unchanged fingerprint → expert
  fires at most once, then next rung / R5.
- full ladder climb on a permanent stall (ScriptedModel) → ends in **bounded R5
  handoff**, not a turn-cap fail and not an infinite loop.
- every terminal exit yields a structured `handoff` (table above).
- provider without per-call temp/reasoning → override **no-ops cleanly**.
- headless read-only spin → guard fires (doesn't reach the backstop).
- greenfield park-and-revisit: a permanently-failing feature parks, others build, it's
  revisited; build reports fully-stuck only when all remaining are parked.
- handoff shape + `lastError` round-trip through persistence.

**Definition of done:** full `bun run validate` green; a scripted "stall-forever" run
ends in a bounded R5 handoff.

---

## Implementation notes / risks

Two changes carry almost all the risk — sequence them first, test them hardest:

1. **Fingerprint state machine.** Getting "novel block" wrong in either direction is
   bad: too loose (full error set) → oscillation re-triggers expert forever; too tight
   → genuine progress reads as the same block and the ladder never restarts. The
   guard-specific derivation + the "tried = completed-turn-then-unmoved" semantics are
   subtle. Build + unit-test this in isolation before anything consumes it.
2. **Per-call model overrides (temp/reasoning).** New plumbing through
   `askModel`/`acquireResponse` and both run drivers, and it must be **provider-aware**
   (DeepSeek pins thinking; OpenAI omits temperature) and must NOT leak into auxiliary
   calls (planning/judge/compaction/expert). A wrong default here silently changes
   model behavior everywhere. Thread it explicitly; test the no-op and the
   auxiliary-stays-default paths.

Lower-risk but non-trivial: greenfield parked-state (a driver + state-machine change,
not a constant deletion) and converting all bypass exits to R5.

---

## Additional required state (consolidated — build with step 1)

Beyond `blockFingerprint` + `triedLeversByBlock`, the mechanics above need:

- **`pendingRung` + `pendingBlockFingerprint`** — cross-gate memory of the lever just
  tested, so "record after next gate unchanged" is implementable.
- **`pendingDiagnosisSteer`** — R1's two-phase marker; R1 is recorded tried only after
  the act-on-diagnosis cycle, never the diagnosis-only cycle.
- **`settleSyntheticBlock(...)`** — the record-and-escalate path for non-gate exits
  (they never reach a next gate, so `settleGate`'s recording can't fire for them).
- **`IHandoff.resume`** — serialized tried-levers / checkpoint ref, so a greenfield
  revisit seeds machine state instead of re-running fresh.
- **`recentGateFingerprints`** (oscillation-window ring buffer) — the plateau branch
  of `fingerprintFor` can't be computed without it.
- **Synthetic terminal fingerprints** — `timeout:…`, `degeneration:…`,
  `malformed-tool-call`, `readonly-spin:…` — so non-gate exits are identity-tracked.
- **`serializeLoopState`/`deserializeLoopState` DTOs** — `Map`/`Set` fields don't
  survive `JSON.stringify`; needed before any checkpoint write.
- **`IGreenfieldDeps.implement` returns + accepts handoff state** — currently
  `Promise<void>`; must return the inner handoff and accept seeded tried-lever state,
  or parked-feature revisits re-fire the same levers from a fresh run.

## Prioritized implementation order

1. Fingerprint semantics + `fingerprintFor` helper + state machine + tests.
2. Headless read-only-spin guard (before any cap change).
3. Structured handoff: `IRunResult.handoff` + `STUCK_REASON.handoff` + convert all
   bypass exits + fix `lastError` persistence.
4. Expert uncap → novel-fingerprint gate.
5. Dynamic levers: R1 feed-forward, R2 per-call overrides (provider-aware, no-op
   tested), R3 narrow.
6. Heartbeat + backstop split (loop-condition change) + checkpoint payload/emission.
7. Greenfield parked state + revisit + `cli.ts:594` wiring + reporting.

Full `bun run validate` green between each; each step independently testable.

---

## Out of scope (separate passes)

- Runtime e2e smoke tier (`TSFORGE_SMOKE`).
- BoringStack **domain behavior** (its generators/gate). NOTE: the structural
  `host.send` signature change (so the driver sees the inner handoff, `build.ts:243`)
  IS in scope — step 7 requires it; only domain logic is out.
- Model-capability / first-shot prompting improvements (complementary, separate).
