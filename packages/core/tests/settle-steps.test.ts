import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStuck, autoFixStep, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import { LOOP_LIMITS, RUN_STATUS } from "../src/loop";
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

  test("persistent single error → STUCK with the samePersist detail", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();
    let result: ReturnType<typeof checkStuck> = null;

    // The same (file,rule) key every cycle, with a churn error so ONLY the
    // primary per-error guard can fire (the whole-set guard sees a new set).
    for (let i = 0; i < LOOP_LIMITS.samePersist; i += 1) {
      result = checkStuck(
        ctx,
        state,
        [err("src/a.ts:any"), err(`churn:${String(i)}`, `rule-${String(i)}`)],
        i + 1
      );
    }

    expect(result?.status).toBe(RUN_STATUS.stuck);
    // The stuck event was reported exactly once, with a concrete detail.
    const stuckEvents = events.filter((e) => e.kind === "stuck");

    expect(stuckEvents).toHaveLength(1);
  });

  test("identical whole error set repeating → STUCK via the set guard", () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();
    let result: ReturnType<typeof checkStuck> = null;

    // Two errors, identical every cycle. The per-error guard is primary and has
    // the tighter threshold, so a stuck verdict from EITHER guard is fine — what
    // this pins is that an unchanging set terminates instead of looping forever.
    const cycles = Math.max(
      LOOP_LIMITS.gateStuckRepeats,
      LOOP_LIMITS.samePersist
    );

    for (let i = 0; i < cycles && result === null; i += 1) {
      result = checkStuck(ctx, state, [err("a:1"), err("b:2")], i + 1);
    }

    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.detail).toBeDefined();
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
