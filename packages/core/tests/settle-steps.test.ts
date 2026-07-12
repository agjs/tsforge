import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStuck, autoFixStep, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import { LOOP_LIMITS, RUN_STATUS } from "../src/loop";
import { STEER_LADDER_MAX } from "../src/loop/feedback/steer";
import type { IErrorItem } from "../src/validate";

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
    gate: { parse: undefined },
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
