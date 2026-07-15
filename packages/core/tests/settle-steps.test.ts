import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStuck, autoFixStep, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import { LOOP_LIMITS, RUN_STATUS } from "../src/loop";
import { STEER_LADDER_MAX } from "../src/loop/feedback/steer";
import type { IErrorItem } from "../src/validate";
import { commandGate } from "../src/gate/gate-runner";

/** The settleGate steps extracted for unit testing (review item 4): checkStuck
 *  composes the three convergence guards; autoFixStep reports what the janitor
 *  changed. These pin the ORCHESTRATION seams, not the guards' internals (those
 *  are covered by same-persist-guard.test.ts). */

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    bestErrorCount: Number.POSITIVE_INFINITY,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
    steerLevel: 0,
  };
}

function makeCtx(events: ILoopEvent[], cwd = "/tmp"): ILoopCtx {
  return {
    task: { id: "t", intent: "test", accept: "true", files: [], context: [] },
    cwd,
    tsService: null,
    report: (event) => {
      events.push(event);
    },
    messages: [],
    tool: {},
    gate: {
      parse: undefined,
      runner: commandGate(
        { id: "t", intent: "test", accept: "true", files: [], context: [] },
        undefined
      ),
    },
  };
}

function err(key: string, rule = "no-explicit-any"): IErrorItem {
  return { key, file: "src/a.ts", rule, message: `${rule} at ${key}` };
}

describe("checkStuck (the composed convergence guards)", () => {
  test("returns null while the error set is still changing (keep looping)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    // Two cycles with DIFFERENT error sets — no guard should fire.
    expect(checkStuck(ctx, state, [err("a:1")], 1)).toBeNull();
    expect(checkStuck(ctx, state, [err("b:2")], 2)).toBeNull();
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(0);
  });

  test("a persisting error ESCALATES steers, then parks once the ladder is exhausted", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    // The same (file,rule) every cycle: the first stall is detected patiently
    // (samePersist), then steering ESCALATES fast (steerRetrigger) up the ladder.
    // Drive cycles until the FIRST terminal, then assert the whole ladder was climbed
    // exactly once — robust to the precise cadence (a generous bound can't loop).
    let result: ReturnType<typeof checkStuck> = null;
    const bound =
      LOOP_LIMITS.samePersist +
      LOOP_LIMITS.steerRetrigger * (STEER_LADDER_MAX + 2);

    for (let i = 0; i < bound && result === null; i += 1) {
      result = checkStuck(ctx, state, [err("src/a.ts:any")], i + 1);
    }

    // It parked at the top of the ladder (not an instant kill).
    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.detail).toContain("steering exhausted");
    expect(state.steerLevel).toBe(STEER_LADDER_MAX + 1);

    // MAX steers were injected (L1..LMAX) before the single park event.
    const steers = events.filter(
      (e) => e.kind === "tool" && e.message.includes("steer")
    );

    expect(steers).toHaveLength(STEER_LADDER_MAX);
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(1);
  });

  test("an unchanging error set steers, then parks (never loops forever)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();
    let result: ReturnType<typeof checkStuck> = null;

    // Two errors, identical every cycle. Steering keeps the run alive through the
    // ladder, but an unchanging set must EVENTUALLY park — never loop forever. Give
    // it well past the ladder's height and assert it lands on a terminal park.
    const cap =
      LOOP_LIMITS.samePersist * (STEER_LADDER_MAX + 1) +
      LOOP_LIMITS.gateStuckRepeats;

    for (let i = 0; i < cap && result?.status !== RUN_STATUS.stuck; i += 1) {
      result = checkStuck(ctx, state, [err("a:1"), err("b:2")], i + 1);
    }

    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.detail).toContain("steering exhausted");
  });

  test("a shrinking error count never trips any guard (converging run)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    // 5 → 4 → 3 → 2 → 1 distinct errors: converging, must keep looping.
    for (let n = 5; n >= 1; n -= 1) {
      const set = Array.from({ length: n }, (_, i) =>
        err(`e${String(n)}-${String(i)}:x`, `r${String(n)}-${String(i)}`)
      );

      expect(checkStuck(ctx, state, set, 6 - n)).toBeNull();
    }
  });

  test("the plateau ESCALATES the ladder even when no fine guard trips (fixes the slow climb)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    // Fresh state (all fine-guard counters at 0, so none can trip on a single call), but
    // one gate short of the plateau, with the all-time low (1) already hit. THIS gate is
    // pure oscillation. If it escalates, the PLATEAU is the only possible trigger — this
    // is the guard v6/v8 lacked, which let them crawl 150+ turns without reaching L3.
    const state: ILoopState = {
      ...freshState(),
      redGates: LOOP_LIMITS.plateauGates - 1,
      plateauBest: 1,
    };

    const result = checkStuck(ctx, state, [err("x:1")], 5);

    expect(result).toBeNull(); // escalated + keep looping (not parked, not ignored)
    expect(state.steerLevel).toBe(1); // climbed a rung on the plateau alone
    expect(
      events.some((e) => e.kind === "tool" && e.message.includes("oscillating"))
    ).toBe(true);
  });

  test("sustained oscillation climbs the WHOLE ladder to the expert-park FAST (not 150 turns)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();
    let result: ReturnType<typeof checkStuck> = null;

    // Every cycle: a DIFFERENT error key (set rotates → the whole-set/persist guards keep
    // resetting) but the count never drops below the all-time low → only the plateau sees
    // it. It must reach the terminal park within a tight bound — the whole point of the fix.
    const bound = LOOP_LIMITS.plateauGates * (STEER_LADDER_MAX + 1) + 5;

    for (let i = 0; i < bound && result?.status !== RUN_STATUS.stuck; i += 1) {
      result = checkStuck(ctx, state, [err(`k${String(i)}:1`)], i + 1);
    }

    expect(result?.status).toBe(RUN_STATUS.stuck); // reached the expert-park
    expect(result?.detail).toContain("steering exhausted");
  });

  test("plateau-only exhaustion hands off with a NON-EMPTY rungHistory keyed on the stable fingerprint", () => {
    // Regression: the block fingerprint depends on redGates, which the plateau tracker
    // mutates mid-cycle. When the fingerprint was computed twice per cycle (once before
    // and once after that mutation), rungs were recorded under one key but the handoff
    // looked them up under another → EMPTY rungHistory (broke the "seed what was tried"
    // contract). This drives the plateau-ONLY path (rotating keys, so no fine guard fires
    // and no single key recurs → the plateau fingerprint stays stable as `${low}|`) to
    // ladder exhaustion and asserts the handoff carries the rungs that were actually
    // applied, keyed on the same stable fingerprint (never empty, never "escalation-N").
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();
    let result: ReturnType<typeof checkStuck> = null;

    const bound = LOOP_LIMITS.plateauGates * (STEER_LADDER_MAX + 1) + 5;

    for (let i = 0; i < bound && result?.status !== RUN_STATUS.stuck; i += 1) {
      result = checkStuck(ctx, state, [err(`k${String(i)}:1`)], i + 1);
    }

    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.handoff).toBeDefined();
    // The rungs actually climbed on this block must appear in the handoff.
    expect((result?.handoff?.rungHistory ?? []).length).toBeGreaterThan(0);
    // Keyed on the real (stable) fingerprint, not the old synthetic escalation-N value.
    expect(result?.handoff?.block ?? "").not.toBe("");
    expect(result?.handoff?.block ?? "").not.toContain("escalation-");
    // resume seeds the SAME tried-levers a greenfield revisit relies on.
    const resume = result?.handoff?.resume;
    const resumeLevers =
      resume !== undefined && "triedLevers" in resume ? resume.triedLevers : [];

    expect(resumeLevers.length).toBeGreaterThan(0);
  });
});

describe("autoFixStep", () => {
  test("no fixers configured + nothing changed → [] and no report", async () => {
    const events: ILoopEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "settle-autofix-"));

    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");

    const ctx = makeCtx(events, dir);

    // No tsService, no task.fix, file lists empty → the janitor is a no-op.
    const autoFixed = await autoFixStep(ctx);

    expect(autoFixed).toEqual([]);
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(0);
  });

  test("task.fix that rewrites a scoped file → reported as auto-fixed", async () => {
    const events: ILoopEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "settle-autofix-"));

    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");

    const ctx = makeCtx(events, dir);
    // A real fix command that touches the scoped file (mtime moves forward).
    const fixCtx: ILoopCtx = {
      ...ctx,
      task: {
        ...ctx.task,
        files: ["a.ts"],
        fix: "sleep 1 && echo 'export const a = 2;' > a.ts",
      },
    };

    const autoFixed = await autoFixStep(fixCtx);

    expect(autoFixed).toEqual(["a.ts"]);
    // The step reported the auto-fix so the model gets the notice.
    const tool = events.filter((e) => e.kind === "tool");

    expect(tool).toHaveLength(1);
    expect(tool[0]?.message).toContain("auto-fixed 1 file(s)");
    // Generous timeout: the fix command sleeps 1s to move mtime forward, and a
    // loaded machine can stretch the spawn well past bun's 5s default.
  }, 30_000);
});

describe("relentless-loop escalation-ladder centerpiece (fixes A/B/C)", () => {
  test("A: a NEW ALL-TIME LOW restarts the ladder; an equal-count error swap does NOT (oscillation-proof)", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);

    // Progress is the OSCILLATION-PROOF signal: a new all-time-low error count — NOT a
    // change in the fingerprint string. An equal-count error swap (fix a:1, break b:2)
    // is oscillation; treating it as progress would let a flailing model reset the
    // ladder every cycle and dodge escalation forever (the "150-turn" disease).

    // (1) Equal-count swap under an established plateau → HELD (not progress).
    const osc = freshState();

    osc.steerLevel = 2;
    osc.blockFingerprint = "a:1";
    osc.plateauBest = 1; // best-ever is already 1 error
    osc.errorAge.set("b:2", LOOP_LIMITS.samePersist + 1);
    checkStuck(ctx, osc, [err("b:2")], 100); // still ONE error → no new low

    expect(osc.blockFingerprint).toBe("a:1"); // identity HELD — not a move
    expect(osc.steerLevel).toBeGreaterThan(0); // ladder NOT reset to 0

    // (2) A genuine new all-time low (fewer errors than ever seen) → ladder RESTARTS.
    const prog = freshState();

    prog.steerLevel = 2;
    prog.blockFingerprint = "a:1";
    prog.plateauBest = 3; // best-ever was 3 errors …
    prog.pendingRung = "R2";
    prog.pendingBlockFingerprint = "a:1";
    checkStuck(ctx, prog, [err("x:1")], 101); // … now only 1 error → NEW LOW = progress

    expect(prog.blockFingerprint).toBe(""); // block cleared on progress
    expect(prog.steerLevel).toBe(0); // ladder restarted
    expect(prog.pendingRung).toBeNull();
    expect(prog.pendingBlockFingerprint).toBeNull();
  });

  test("advancing through a short-circuit gate phase resets an exhausted block even when more errors appear", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    state.prevGateErrors = [{ ...err("api:1"), phase: 1 }];
    state.steerLevel = STEER_LADDER_MAX;
    state.blockFingerprint = "api:1";
    state.plateauBest = 1;
    state.pendingRung = "R3";
    state.pendingBlockFingerprint = "api:1";

    const uiErrors = Array.from({ length: 5 }, (_, index) => ({
      ...err(`ui:${String(index)}`, "logic-files-require-test-sibling"),
      phase: 2,
    }));
    const result = checkStuck(ctx, state, uiErrors, 200);

    expect(result).toBeNull();
    expect(state.steerLevel).toBe(0);
    expect(state.blockFingerprint).toBe("");
    expect(state.plateauBest).toBe(5);
    expect(state.bestErrorCount).toBe(5);
    expect(state.pendingRung).toBeNull();
  });

  test("B: R2 and R3 set pendingRung; recorded on next-gate unmoved", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    // Test the pending-rung recording mechanic: when a rung is applied and set as
    // pendingRung, it's recorded into triedLeversByBlock when the next gate shows
    // the block unchanged.

    // Set up state as if R2 was just applied on block "a:1". plateauBest=1 (== the open
    // error count) so this cycle is NOT a new all-time low — i.e. the block is UNMOVED,
    // which is exactly the "record the pending rung" case.
    state.steerLevel = 2;
    state.blockFingerprint = "a:1";
    state.plateauBest = 1;
    state.pendingRung = "R2";
    state.pendingBlockFingerprint = "a:1";
    state.errorAge.set("a:1", LOOP_LIMITS.samePersist + 1); // persistent block
    state.triedLeversByBlock = new Map([["a:1", new Set(["R1"])]]);

    // Call checkStuck with the same block
    // The recording hook at the top will fire: R2 should be recorded to triedLeversByBlock
    checkStuck(ctx, state, [err("a:1")], 100);

    // Verify: R2 was recorded to triedLeversByBlock["a:1"]
    const tried = state.triedLeversByBlock.get("a:1");

    expect(tried?.has("R2")).toBe(true);
    expect(tried?.has("R3")).toBe(false); // R3 not yet applied, so not recorded
  });

  test("C: exhaustion handoff keyed on stable fingerprint with complete rungHistory", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    // Set up state at steerLevel=STEER_LADDER_MAX on a samePersist block "a:1"
    // (when stall fires, steerLevel increments to STEER_LADDER_MAX+1 → terminal).
    // plateauBest=1 (== open error count) so this cycle is NOT a new low — the block is
    // unmoved and the sticky identity "a:1" is held into the handoff.
    state.steerLevel = STEER_LADDER_MAX;
    state.blockFingerprint = "a:1";
    state.plateauBest = 1;
    state.errorAge.set("a:1", LOOP_LIMITS.samePersist + 1); // will fire samePersist
    state.triedLeversByBlock = new Map([["a:1", new Set(["R1", "R2", "R3"])]]);

    // Call checkStuck: samePersist fires, stall, steerLevel increments to STEER_LADDER_MAX+1
    const result = checkStuck(ctx, state, [err("a:1")], 200);

    // Should be a terminal handoff result
    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.reason).toBe("handoff");
    expect(result?.handoff).toBeDefined();

    const handoff = result?.handoff;

    // The block key should be the stable fingerprint from fingerprintFor ("a:1"),
    // not a synthetic "escalation-N" key
    expect(handoff?.block).toBe("a:1");
    expect(handoff?.block).not.toMatch(/^escalation-/);

    // rungHistory should contain the recorded rungs
    expect(handoff?.rungHistory).toBeDefined();
    expect((handoff?.rungHistory ?? []).length).toBeGreaterThan(0);
    expect(Array.from(handoff?.rungHistory ?? [])).toContain("R1");
    expect(Array.from(handoff?.rungHistory ?? [])).toContain("R2");
    expect(Array.from(handoff?.rungHistory ?? [])).toContain("R3");

    // resume.triedLevers should match rungHistory
    if (handoff?.resume && "triedLevers" in handoff.resume) {
      expect(handoff.resume.triedLevers).toEqual(handoff.rungHistory);
    }
  });
});
