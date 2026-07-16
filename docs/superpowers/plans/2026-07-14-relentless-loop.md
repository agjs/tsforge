# Relentless Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the harness's arbitrary numeric stoppers (`maxTurns`, `EXPERT_MAX_USES`, `maxAttemptsPerFeature`) with a progress-gated escalation ladder whose only terminal state is a structured, resumable **R5 handoff** — so a run is either still productively working or it climbed the whole ladder and handed off cleanly, never idle-failed early.

**Architecture:** Extend the existing machinery in the **main loop** (`loop/turn.ts`, `loop/session.ts`, `loop/run.ts`) — it is codebase-agnostic; greenfield/BoringStack is one consumer. Add a guard-specific **`blockFingerprint`** + **`triedLeversByBlock`** state machine that decides escalation on *progress*, not counts. Levers R1–R4 already largely exist (`buildSteerMessage` L1/L2/L3, `tryExpertRescue`); this completes them, un-caps expert on a novel-block gate, converts every terminal exit to a structured `IHandoff`, and makes greenfield park-and-revisit instead of drop-after-3.

**Tech Stack:** TypeScript (strict), Bun test runner. No `as` casts, no `eslint-disable`, cognitive complexity ≤ 20, shared AST walkers. Full source: `docs/superpowers/specs/2026-07-14-relentless-loop-design.md` (the binding spec — read it; this plan decomposes it).

## Global Constraints

- **Never relax the gate.** No downgrading rules/severity to "warnings". Fixes make the model satisfy the gate; they never weaken it.
- **No `as` casts, no `eslint-disable`, no `@ts-ignore`.** Type-narrow with guards. Cognitive complexity ≤ 20 per function.
- **`ILoopState` holds `Map`/`Set` fields** (`errorAge`, `pushedGuides`, and the new `triedLeversByBlock`) — these DO NOT survive `JSON.stringify` (flatten to `{}`). Any persistence path MUST go through the `serializeLoopState`/`deserializeLoopState` DTO helpers (Task 6).
- **`EscalationRung = "R1" | "R2" | "R3" | "R4"`** is the ONLY thing stored in `triedLeversByBlock` / `rungHistory` / `pendingRung`. **R0** = default no-lever state (not stored). **R5** = terminal `status` only (never "tried" or "picked").
- **`runawayBackstopTurns = 1000`** is a crash-guard (anomaly-logged), NOT a task cap. **`checkpointIntervalTurns = 40`** is a heartbeat, does NOT terminate.
- **Provider-aware per-call overrides** must be **best-effort and no-op cleanly** where unsupported (DeepSeek pins thinking per-conversation; OpenAI omits temperature) and must **NEVER leak into auxiliary calls** (planning, judge, compaction, expert — those stay on defaults).
- **Focus filter (R3)** filters ONLY the model-facing feedback string; `blockFingerprint` and all progress guards are computed from the **UNFILTERED** gate error set.
- **`fingerprintFor` is guard-specific, NOT the raw error set** — an A↔B oscillation must yield a STABLE fingerprint (else the ladder re-triggers forever).
- Run `bun run validate` and read the REAL `N pass / M fail` summary (the harness has misreported exit 0 on a failed run — never trust the exit-code notification alone). Baseline focused suite: **74 pass** (`session-e2e-hunt` + the loop suites named in the spec's Testing section).
- Work stays on branch `feat/escalation-ladder`. Never touch `main`.

---

### Task 1: Fingerprint state machine + `fingerprintFor` / `isTrivialDiagnosis` helpers

The highest-risk piece. Build it in ISOLATION with unit tests before anything consumes it. Getting "novel block" wrong either way is fatal: too loose (raw error set) → oscillation re-triggers expert forever; too tight → genuine progress reads as the same block and the ladder never restarts.

**Files:**
- Modify: `packages/core/src/loop/turn.ts` — add fields to `ILoopState` (line 286-336); add `fingerprintFor`, `isTrivialDiagnosis`, and the `EscalationRung` type near `trackErrorAges`/`checkStuck`.
- Create: `packages/core/tests/fingerprint.test.ts`

**Interfaces:**
- Consumes: existing `ILoopState` (`turn.ts:286`), `trackErrorAges` (`turn.ts:794`), `sameErrorSet` (`validate/errors.ts:26`), `IErrorItem` (has a `key` field, e.g. `"src/x.ts:no-unsafe-argument"`).
- Produces (later tasks rely on these EXACT names/signatures):
  - `export type EscalationRung = "R1" | "R2" | "R3" | "R4";`
  - `export function fingerprintFor(state: ILoopState, gateErrors: IErrorItem[]): string;` (`""` = no active block)
  - `export function isTrivialDiagnosis(content: string, errors: IErrorItem[]): boolean;`
  - New `ILoopState` fields: `blockFingerprint: string`, `recentGateFingerprints: string[]`, `triedLeversByBlock: Map<string, Set<EscalationRung>>`, `pendingRung: EscalationRung | null`, `pendingBlockFingerprint: string | null`, `pendingDiagnosisSteer: string | null`, `focusError: string | null`, `pendingModelOverride: IModelOverride | null` (type defined in Task 5; declare the field as the type and let Task 5 fill the shape — for Task 1 use `pendingModelOverride?: { temperature?: number; reasoningEffort?: string; enableThinking?: boolean; thinkingTokenBudget?: number } | null`).

**Fingerprint derivation (spec §"State the loop must track", `fingerprintFor`):**
```
fingerprintFor(state, gateErrors):
  if samePersist fired      → the single persisted key from trackErrorAges (e.g. "src/x.ts:no-unsafe-argument")
  else if gateStuckRepeats  → sorted-join of the current error keys
  else if plateau/no-new-low→ `${lowWaterCount}|${sorted recurring rule keys over recentGateFingerprints}`
  else                      → "" (no active block)
```
`recentGateFingerprints` is a ring buffer (length = `LOOP_LIMITS.noProgressCycles` = 12) of sorted key-sets, pushed each gate cycle, cleared when the block genuinely moves. The plateau branch reads recurring rule keys across it (a key present in ≥2 of the window's entries).

- [ ] **Step 1: Write the failing tests** in `packages/core/tests/fingerprint.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { fingerprintFor, isTrivialDiagnosis } from "../src/loop/turn";
import type { ILoopState } from "../src/loop/turn";
import type { IErrorItem } from "../src/validate";

const err = (key: string, message = key): IErrorItem => ({ key, message });

// Minimal ILoopState factory — fill only what fingerprintFor reads.
function state(over: Partial<ILoopState> = {}): ILoopState {
  return {
    prevGateErrors: [], gateNoProgress: 0, bestErrorCount: 99, noNewLow: 0,
    errorAge: new Map(), lastGateCount: 0, edits: 0, regressions: 0,
    ttsrInterrupts: 0, steerLevel: 0,
    blockFingerprint: "", recentGateFingerprints: [],
    triedLeversByBlock: new Map(), pendingRung: null,
    pendingBlockFingerprint: null, pendingDiagnosisSteer: null,
    focusError: null, pendingModelOverride: null,
    ...over,
  };
}

describe("fingerprintFor", () => {
  test("oscillating error SET yields a STABLE fingerprint, not novel each cycle", () => {
    // A↔B alternation: sameErrorSet reads 'moved' each cycle, but the plateau
    // branch over the window must produce the SAME string both ways.
    const window = ["src/a.ts:rule-x", "src/b.ts:rule-y"];
    const s1 = state({
      redGates: 4, plateauBest: 3,
      recentGateFingerprints: [window[0], window[1], window[0], window[1]],
    });
    const fpA = fingerprintFor(s1, [err("src/a.ts:rule-x")]);
    const fpB = fingerprintFor(s1, [err("src/b.ts:rule-y")]);
    expect(fpA).toBe(fpB);
    expect(fpA).not.toBe("");
  });

  test("a single persisted key (samePersist) fingerprints to that key", () => {
    const s = state();
    // drive errorAge so the key has survived samePersist cycles
    for (let i = 0; i < 5; i += 1) fingerprintFor(s, [err("src/x.ts:no-unsafe-argument")]);
    expect(fingerprintFor(s, [err("src/x.ts:no-unsafe-argument")]))
      .toBe("src/x.ts:no-unsafe-argument");
  });

  test("no active stall → empty string", () => {
    expect(fingerprintFor(state(), [])).toBe("");
  });

  test("genuine resolution (new low) produces a DIFFERENT fingerprint than the stall", () => {
    const stalled = fingerprintFor(
      state({ redGates: 4, plateauBest: 3, recentGateFingerprints: ["src/a.ts:rule-x"] }),
      [err("src/a.ts:rule-x")]
    );
    const resolved = fingerprintFor(state({ bestErrorCount: 0 }), []);
    expect(resolved).not.toBe(stalled);
  });
});

describe("isTrivialDiagnosis", () => {
  test("short output is trivial", () => {
    expect(isTrivialDiagnosis("nope", [err("a:b")])).toBe(true);
  });
  test("output that only restates the errors is trivial", () => {
    expect(isTrivialDiagnosis("the error a:b is still failing", [err("a:b", "a:b")])).toBe(true);
  });
  test("a substantive genuinely-different hypothesis is NOT trivial", () => {
    const diag = "The root cause is that the type guard narrows on the wrong discriminant; " +
      "I should switch to narrowing on `kind` and construct the value from a factory instead.";
    expect(isTrivialDiagnosis(diag, [err("a:b")])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test packages/core/tests/fingerprint.test.ts` → FAIL (`fingerprintFor is not exported` / undefined). Read `turn.ts` `trackErrorAges` (794-803), `checkStuck` (1053-1161), `sameErrorSet` in `validate/errors.ts` to ground the real guard logic before implementing.

- [ ] **Step 3: Add the `ILoopState` fields** (after line 335, before the closing brace) and the `EscalationRung` type. Field JSDoc must state the spec's semantics (guard-specific, ring buffer len=12, pending pair, R1 two-phase marker, focusError captured-not-derived).

- [ ] **Step 4: Implement `fingerprintFor` + `isTrivialDiagnosis`** as pure exported functions. `fingerprintFor` mirrors `checkStuck`'s guard order (persisted → whole-set → plateau) but RETURNS the identity string; it must NOT duplicate `checkStuck`'s state mutations beyond what's needed to read the persisted key (reuse `trackErrorAges`'s output or a read-only variant — do not double-count ages when both run in the same cycle; document the call contract). `isTrivialDiagnosis`: `content.trim().length < 80` OR normalized content is a superset of the error messages (only restates them).

- [ ] **Step 5: Run tests to verify they pass** — `bun test packages/core/tests/fingerprint.test.ts` → PASS.

- [ ] **Step 6: Full validate** — `bun run validate`; read the real pass/fail summary (baseline 74 focused + full suite green).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(loop): guard-specific blockFingerprint + fingerprintFor/isTrivialDiagnosis (relentless R1)"`

---

### Task 2: Headless read-only-spin guard

Port the interactive read-only-spin guard into the headless driver BEFORE any cap is raised — otherwise, once `runawayBackstopTurns` is high (Task 6), a model that keeps reading without acting would burn 1000 turns.

**Files:**
- Modify: `packages/core/src/loop/run.ts` (headless driver; read-only paths ~501/529, no guard today).
- Reference (read, don't change): the interactive `readonlySpinStop` in `packages/core/src/loop/session.ts:1792`.
- Test: `packages/core/tests/run-readonly-spin.test.ts` (create, or extend the existing headless run test file if one covers `run.ts` — check `packages/core/tests/` for `run.test.ts` / `repair-loop.test.ts` first and follow its harness).

**Interfaces:**
- Consumes: the interactive guard's shape (consecutive read-only turns → stop reason).
- Produces: headless `run.ts` now detects N consecutive tool-only-read turns and escalates (feeds "you keep reading — act now") before the backstop; the count/threshold matches the interactive guard.

- [ ] **Step 1: Read** `session.ts:1792` `readonlySpinStop` and the interactive read-only detection to learn the exact signal (what counts as a read-only turn, the threshold).
- [ ] **Step 2: Write the failing test** — a ScriptedModel that only issues read tools (no edits/creates) for N+1 turns; assert `run.ts` emits the read-only-spin escalation/stop rather than looping to the backstop.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** the guard in `run.ts`, mirroring the interactive one (shared helper if the interactive one is extractable without churn; otherwise a faithful port with a shared threshold constant).
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: `bun run validate`** green.
- [ ] **Step 7: Commit** — `git commit -m "feat(loop): headless read-only-spin guard (before backstop raise)"`

---

### Task 3: Structured handoff — types, `buildHandoffAsk`, all bypass exits, `lastError` persistence

Introduce `IHandoff` and route EVERY terminal exit through a structured, resumable handoff (not just `stuckResult`). Also fix the greenfield `toFeature` bug dropping `lastError` on load.

**Files:**
- Modify: `packages/core/src/loop/loop.constants.ts` — add `handoff: "handoff"` to `STUCK_REASON`.
- Modify: `packages/core/src/loop/loop.types.ts` — add `IHandoff` interface + `handoff?: IHandoff` to `IRunResult`; add `handoff` to `ISendResult` (session) and to `ILoopEvent` (for the rich event); add the new event kind if needed for the handoff report.
- Modify: `packages/core/src/loop/session.ts` — convert bypass exits (build-nudge exhaustion ~1213, degeneration ~1254, repeated timeout ~1300) to R5 handoff; thread `handoff` through `settleTurn` (~1651) and `ISendResult` (~120).
- Modify: `packages/core/src/loop/run.ts` — headless degeneration (~491) → R5 handoff; cap (~544) → anomaly backstop (stays `.cap`).
- Modify: `packages/core/src/loop/turn.ts` — add `buildHandoffAsk`; `stuckResult`/`checkStuck` exhaustion path emits `handoff`.
- Modify: `packages/core/src/loop/greenfield/state.ts:40` — `toFeature` must round-trip `lastError` (currently dropped).
- Test: `packages/core/tests/handoff.test.ts` (create); extend `packages/core/tests/greenfield.test.ts` for the `lastError` round-trip.

**Interfaces (Produces — exact shape from spec §"IRunResult + handoff shape"):**
```ts
export interface IHandoff {
  block: string;                 // surviving blockFingerprint
  rungHistory: EscalationRung[]; // ordered levers tried on the final block
  errors: string[];              // persisting error keys/messages
  ask: string;                   // what a human/stronger model/more context is needed for
  resumable: true;
  resume: { triedLevers: EscalationRung[] } | { checkpointRef: string };
}
// IRunResult gains:  handoff?: IHandoff
// STUCK_REASON gains: handoff (status stays "stuck"; handoff distinguished by handoff !== undefined)
export function buildHandoffAsk(finalSteer: string, persistingErrors: string[]): string; // pure, tested
```

- [ ] **Step 1: Write failing tests** in `handoff.test.ts`: (a) `buildHandoffAsk` derives a non-empty ask from a steer + error set; (b) a scripted permanent stall through `checkStuck` exhaustion yields `IRunResult.status === "stuck"`, `reason === STUCK_REASON.handoff`, and a populated `handoff` with `resumable: true` and `rungHistory` covering the levers tried. In `greenfield.test.ts`: a feature persisted with `lastError` reloads with `lastError` intact.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `STUCK_REASON.handoff`, `IHandoff`, `buildHandoffAsk` (pure), and convert each bypass exit per the spec's exit table. Thread `handoff` through `ISendResult`/`settleTurn`/`ILoopEvent`. Fix `toFeature` to read `lastError` (`typeof lastError === "string"` guard). Emit the handoff as a rich event listing tried levers.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: `bun run validate`** green — expect to touch `settle-steps`, `session.test`; keep never-yielding/runaway coverage green.
- [ ] **Step 6: Commit** — `git commit -m "feat(loop): structured resumable IHandoff at every terminal exit + lastError round-trip"`

---

### Task 4: Expert re-enters on a novel block (replace `EXPERT_MAX_USES`)

Replace the flat 2-use cap with the `triedLeversByBlock` novelty gate: the expert (R4) may fire again whenever the block fingerprint is NOVEL; on an unchanged fingerprint it's already recorded and the next unfilled rung (or R5) is next.

**Files:**
- Modify: `packages/core/src/loop/turn.ts` — `tryExpertRescue` (~948-1029): remove `EXPERT_MAX_USES` (940) and the `expertUses >= cap` skip (967); gate on `triedLeversByBlock[fingerprint].has("R4")` instead. On a successful expert fix, DO NOT blanket-reset the ladder if the fingerprint is unchanged — record R4 tried for the block and let the next rung/R5 follow (spec §"State-machine semantics").
- Modify: the `settleGate` call site (`turn.ts:1320-1327`) so expert is invoked as rung R4 within the fingerprint state machine, not as a post-ladder afterthought.
- Test: extend `packages/core/tests/expert-rescue.test.ts`.

**Interfaces:**
- Consumes: `fingerprintFor` + `triedLeversByBlock` (Task 1); `IHandoff` (Task 3).
- Produces: expert fires at most once per distinct block fingerprint; a genuinely new block (progress) re-enables it.

- [ ] **Step 1: Write failing tests**: (a) unchanged fingerprint across many stalls → expert (`resolveAsk` spy) invoked at most once, then R5 handoff; (b) fingerprint CHANGES after an expert fix (progress) then stalls again on a NEW block → expert may fire again for the new block.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the novelty gate; delete `EXPERT_MAX_USES` and `state.expertUses` reliance (keep the field only if other code reads it — check; the spec treats expert as R4 in `triedLeversByBlock`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: `bun run validate`** green (the `EXPERT_MAX_USES` assertion in `expert-rescue.test` changes).
- [ ] **Step 6: Commit** — `git commit -m "feat(loop): expert re-enters on a novel blockFingerprint (drop EXPERT_MAX_USES)"`

---

### Task 5: Dynamic levers — R1 feed-forward, R2 per-call overrides, R3 narrow

The backbone: content-free, progress-gated levers. Highest secondary risk is R2's per-call override plumbing — it must be provider-aware and MUST NOT leak into auxiliary calls.

**Files:**
- Modify: `packages/core/src/inference/inference.types.ts` — add `reasoningEffort?` to `ICompleteOptions` (146; `temperature`/`enableThinking`/`thinkingTokenBudget` already per-call).
- Modify: `packages/core/src/inference/request.ts` — `buildRequestBody` reads per-call `reasoningEffort` (currently only `cfg.reasoningEffort` at 71); add a **no-tools call mode** (pass `tools: []`/`undefined` in addition to `toolChoice: "none"`, since request building always sends the `tools` block at 109 and suppresses `tool_choice` for DeepSeek at 113) for R1 Phase A.
- Modify: `packages/core/src/loop/session.ts` — thread `pendingModelOverride` through `askModel` (~1070) → `acquireResponse` (~1336); capture point at `run.ts:310`. Auxiliary calls (planning/judge/compaction/expert) stay on defaults.
- Modify: `packages/core/src/loop/turn.ts` — R1 two-phase (`pendingDiagnosisSteer` → capture `res.content` → Phase B `pendingSteer` quoting it + set `pendingRung = "R1"`; trivial diagnosis via `isTrivialDiagnosis` → mark tried, skip Phase B); R2 sets `pendingModelOverride` on entry (best-effort per provider); R3 sets `focusError` (captured when `samePersist` identifies the key in `checkStuck` ~1053-1100, stored alongside the fingerprint) and clears it when the block moves.
- Modify: `packages/core/src/loop/feedback/feedback.ts` — `focusError` filters BOTH `errors` and `metaViolations` (rendered separately at 35/77); meta key is `${file}:${ruleId}`. Filter reaches the actual feedback STRING, not just the top-level inject.
- Modify: `packages/core/src/loop/feedback/steer.ts` — R1 Phase A diagnosis-only variant of `buildSteerMessage(1)`.
- Test: extend `packages/core/tests/steer.test.ts`; create `packages/core/tests/model-override.test.ts`.

**Interfaces (Produces):**
```ts
// The pendingModelOverride shape (finalize the field declared in Task 1):
interface IModelOverride {
  temperature?: number;
  reasoningEffort?: string;   // DeepSeek/OpenAI dialect
  enableThinking?: boolean;   // Qwen dialect
  thinkingTokenBudget?: number;
}
```

- [ ] **Step 1: Write failing tests**: (a) a provider with no per-call temp/reasoning support → override **no-ops cleanly** (request body unchanged, no throw); (b) the no-tools call mode produces a request with NO advertised tools; (c) R1 Phase A sets `pendingDiagnosisSteer` and does NOT set `pendingRung`; Phase B quotes the captured diagnosis and sets `pendingRung = "R1"`; a trivial diagnosis marks R1 tried and skips Phase B; (d) R3 `focusError` filters both `errors` and `metaViolations` in the rendered feedback string while the fingerprint is computed from the UNFILTERED set; (e) auxiliary calls (judge/compaction) never receive `pendingModelOverride`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**, threading explicitly. Read `request.ts:71/109/113/181`, `session.ts:1070/1336`, `feedback.ts:35/77` first. Keep provider-awareness centralized in `buildRequestBody`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: `bun run validate`** green.
- [ ] **Step 6: Commit** — `git commit -m "feat(loop): dynamic levers — R1 feed-forward, R2 per-call overrides (provider-aware/no-op), R3 narrow"`

---

### Task 6: Heartbeat + backstop split + synthetic-block settle + checkpoint DTOs

Collapse the three turn caps into ONE shared `runawayBackstopTurns` crash-guard; add the `checkpointIntervalTurns` heartbeat; add `settleSyntheticBlock` for non-gate exits; add `serializeLoopState`/`deserializeLoopState` DTOs. This is the loop-CONDITION change — sequence it after the state machine + handoff exist.

**Files:**
- Modify: `packages/core/src/loop/loop.constants.ts` — add `runawayBackstopTurns: 1000` and `checkpointIntervalTurns: 40`; the three old caps (`maxTurns:40`, `interactiveBackstopTurns:250`, `webMaxTurns:400`) are REPLACED — remove them or alias them to `runawayBackstopTurns` (keep whichever keeps callers compiling; the spec's decision: one number, crash-guard semantics).
- Modify: `packages/core/src/loop/session.ts` (`driveInner` for-bound) + `packages/core/src/loop/run.ts:433` — normal terminal is ladder-exhaustion (R5); the `for`-bound stays ONLY as the crash-guard at `runawayBackstopTurns` (crossing it logs an anomaly, `STUCK_REASON.cap`). Add checkpoint emission every `checkpointIntervalTurns`.
- Modify public `maxTurns` surface: `cli/args.ts:85`, forwarding `cli.ts:117`, recipe schema `config/recipes.ts:37`, `IRunOptions.maxTurns` (`loop.types.ts:144`) — a user-supplied `maxTurns` now maps to `runawayBackstopTurns` (crash-guard), NOT a task cap. Keep the name (alias); document the semantics change in the JSDoc.
- Modify: `packages/core/src/loop/turn.ts` (or a new `loop/checkpoint.ts`) — `settleSyntheticBlock(ctx, state, syntheticFingerprint, exitKind): IRunResult | null` (same return contract as `settleGate`: emits events, pushes a steer, returns terminal `IRunResult` or `null`). Synthetic blocks do NOT climb R1–R4; each exit kind has a small recovery budget (read-only-spin: one "act now" nudge; timeout: one retry) then → R5. Synthetic and real fingerprints are SEPARATE namespaces (spec §"Synthetic↔real boundary rule") — a synthetic exit NEVER touches real `triedLeversByBlock` entries.
- Create: `packages/core/src/loop/checkpoint.ts` — `serializeLoopState(state): unknown` / `deserializeLoopState(dto): ILoopState` (Map→entries[], Set→array); the checkpoint payload writer under `.tsforge/checkpoints/` (compacted messages, full `ILoopState`, rung history, gate command + last output, editable scope). Phase 1: write snapshot + clean handoff report; full conversation resume phased later.
- Test: `packages/core/tests/checkpoint.test.ts` (create) — DTO round-trip preserves `Map`/`Set`; `packages/core/tests/synthetic-block.test.ts` (create); extend the backstop coverage tests.

**Interfaces (Produces):**
- `LOOP_LIMITS.runawayBackstopTurns = 1000`, `LOOP_LIMITS.checkpointIntervalTurns = 40`.
- `settleSyntheticBlock(ctx, state, syntheticFingerprint, exitKind): IRunResult | null`.
- `serializeLoopState(state: ILoopState): unknown`, `deserializeLoopState(dto: unknown): ILoopState`.
- Synthetic fingerprint builders: `timeout:<normalized>`, `degeneration:<task>`, `malformed-tool-call`, `readonly-spin:<lastGateBlock|no-gate>` (normalization strips timestamps/PIDs/line-col/durations).

- [ ] **Step 1: Write failing tests**: (a) `serializeLoopState`→`deserializeLoopState` round-trips a state with a populated `errorAge` Map and `triedLeversByBlock` Map<fp,Set<Rung>> byte-for-byte (Maps/Sets intact, NOT `{}`); (b) a synthetic exit (read-only spin) records against its own synthetic key, spends its recovery budget, then → R5 handoff, WITHOUT touching a pre-seeded real-fingerprint `triedLeversByBlock` entry; (c) a never-yielding/zero-tool scripted model still terminates at `runawayBackstopTurns` as an anomaly (`STUCK_REASON.cap`) — this MUST stay green; (d) the heartbeat emits a checkpoint event every `checkpointIntervalTurns` without terminating.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**. Read `run.ts:433`, the `driveInner` for-loop, `cli/args.ts:85`, `config/recipes.ts:37` first. Keep the crash-guard tests green.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: `bun run validate`** green — the turn-cap assertions change; the runaway/never-yield coverage MUST stay.
- [ ] **Step 6: Commit** — `git commit -m "feat(loop): single runawayBackstopTurns crash-guard + heartbeat + settleSyntheticBlock + loop-state DTOs"`

---

### Task 7: Greenfield parked state + two-pass revisit + wiring

An API change, not a constant deletion. Make greenfield park-and-revisit instead of drop-after-3, seeding the revisit with saved tried-levers.

**Files:**
- Modify: `packages/core/src/loop/greenfield/greenfield.types.ts` — `IFeature` gains `parked?: boolean` + `handoff?: IHandoff` (NOT a stored `status`; derive `open|passing|parked` from `passes`+`parked` in render/result code). `IGreenfieldDeps.implement` signature changes from `Promise<void>` to `Promise<{ handoff?: IHandoff }>` and accepts a seed for prior tried-lever state. Remove `maxAttemptsPerFeature` from `IGreenfieldOptions`.
- Modify: `packages/core/src/loop/greenfield/run.ts` — delete `DEFAULT_MAX_ATTEMPTS`/the `attempts >= maxAttempts` park branch; consume the returned `handoff` to detect ladder exhaustion; on exhaustion set `feature.parked = true` + store `feature.handoff`, skip it; after the main pass, do ONE second pass over parked features, seeding each with its saved `triedLevers` from `feature.handoff.resume`; report fully-stuck only if features remain parked after that pass.
- Modify: `packages/core/src/loop/greenfield/state.ts` — round-trip `parked` + `handoff` (absent → false/undefined, no migration).
- Modify consumers of `IGreenfieldDeps.implement`: CLI `greenfieldDeps.implement` → `runTask` (`packages/core/src/cli.ts:594`) and BoringStack `host.send` (`packages/core/src/loop/boringstack/build.ts:243`) — both ignore the inner result today and must return `{ handoff? }`. `IBoringstackHost.send` (`build.ts:185`) must return `handoff` too.
- Modify: `packages/core/src/loop/greenfield/state.ts` `renderProgress` — render `parked` features distinctly (e.g. `[~]`).
- Test: extend `packages/core/tests/greenfield.test.ts`.

**Interfaces (Consumes):** `IHandoff`, `IHandoff.resume` (Task 3); `EscalationRung` (Task 1).

- [ ] **Step 1: Write failing tests** (fake `IGreenfieldDeps`, per the existing `greenfield.test.ts` DI pattern): (a) a feature whose `implement` returns a `handoff` (ladder-exhausted) is PARKED and SKIPPED — later features still build; (b) after the main pass, the parked feature is REVISITED once, and its `implement` is called with the seeded `triedLevers` from its saved handoff; (c) the build reports fully-stuck (status `stuck`/`stuckFeature`) ONLY when features remain parked after the revisit pass; (d) `parked`/`handoff` round-trip through `saveState`/`loadState`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the signature change, park-skip, and two-pass revisit. Update both consumers (`cli.ts:594`, `build.ts:243`) to return `{ handoff? }` and thread it.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: `bun run validate`** green — `greenfield.test`, `boringstack` build tests, no regression (baseline ~2240 full suite).
- [ ] **Step 6: Commit** — `git commit -m "feat(greenfield): park-and-revisit on ladder exhaustion (drop maxAttemptsPerFeature), seed tried-levers"`

---

## Verification (whole-branch, after Task 7)

- Full `bun run validate` green (typecheck, lint, format, unit, e2e:pty). Read the REAL summary.
- The spec's **definition of done**: a scripted "stall-forever" run (ScriptedModel) climbs the full ladder and ends in a **bounded R5 handoff** — not a turn-cap fail, not an infinite loop. Add this as an integration test if not already covered by Task 3/6.
- Confirm the never-yielding/runaway-backstop coverage still terminates (anomaly path intact).

## Self-Review notes (spec coverage map)

- Fingerprint state machine → Task 1. Headless read-only guard → Task 2. Structured handoff + all exits + `lastError` → Task 3. Expert uncap → Task 4. Dynamic levers (R1/R2/R3) → Task 5. Backstop split + heartbeat + synthetic settle + DTOs → Task 6. Greenfield parked state + revisit + wiring → Task 7.
- Out of scope (per spec): `TSFORGE_SMOKE` runtime tier; BoringStack domain behavior (its generators/gate — only the structural `host.send` signature change is in scope, Task 7); first-shot prompting improvements.

## Not doing / deferred
- Full conversation-resume from checkpoint (Task 6 ships snapshot-write + handoff report; resume phased later).
- Any change to auxiliary-call model params (they stay on defaults by design).
