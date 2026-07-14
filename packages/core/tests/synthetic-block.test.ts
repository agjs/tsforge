import { describe, test, expect, beforeEach } from "bun:test";
import type { ILoopState, ILoopCtx } from "../src/loop/turn";
import { settleSyntheticBlock } from "../src/loop/turn";
import type { ITask } from "../src/spec";
import type { Reporter } from "../src/loop/loop.types";

describe("settleSyntheticBlock", () => {
  let state: ILoopState;
  let ctx: ILoopCtx;
  let events: { kind: string; task: string; message?: string }[];

  beforeEach(() => {
    state = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 0,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: 0,
      edits: 0,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      triedLeversByBlock: new Map(),
    };

    events = [];

    const report: Reporter = (event) => {
      events.push(event);
    };

    const task: ITask = {
      id: "test-task",
      accept: "test",
      files: [],
    };

    ctx = {
      task,
      report,
      cwd: "/test",
      tool: { signal: undefined },
      messages: [],
      rules: [],
      conventions: [],
      policy: null,
    } as unknown as ILoopCtx;
  });

  test("records a synthetic exit and returns null when budget remains", () => {
    const result = settleSyntheticBlock(
      ctx,
      state,
      "readonly-spin:no-gate",
      "readonly-spin",
      1
    );

    expect(result).toBeNull();
    expect(state.triedLeversByBlock).toBeDefined();
    expect(
      state.triedLeversByBlock?.get("readonly-spin:no-gate")
    ).toBeDefined();
  });

  test("exhausts recovery budget and returns handoff", () => {
    // readonly-spin has budget=1, so two calls should exhaust it
    settleSyntheticBlock(
      ctx,
      state,
      "readonly-spin:no-gate",
      "readonly-spin",
      1
    );

    const result = settleSyntheticBlock(
      ctx,
      state,
      "readonly-spin:no-gate",
      "readonly-spin",
      2
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("stuck");
    expect(result?.reason).toBe("handoff");
    expect(result?.handoff?.block).toBe("readonly-spin:no-gate");
  });

  test("never touches real gate fingerprints in triedLeversByBlock", () => {
    // Pre-seed a real gate fingerprint entry
    const realFingerprint = "src/x.ts:rule-1";

    state.triedLeversByBlock = new Map([[realFingerprint, new Set(["R1"])]]);

    // Process a synthetic exit
    settleSyntheticBlock(ctx, state, "timeout:normalized", "timeout", 1);

    // Verify the real entry is untouched
    expect(state.triedLeversByBlock.get(realFingerprint)).toEqual(
      new Set(["R1"])
    );

    // Verify the synthetic entry is separate
    expect(state.triedLeversByBlock.get("timeout:normalized")).toBeDefined();
    expect(state.triedLeversByBlock.get("timeout:normalized")).not.toEqual(
      state.triedLeversByBlock.get(realFingerprint)
    );
  });

  test("degeneration has zero budget (immediate handoff)", () => {
    const result = settleSyntheticBlock(
      ctx,
      state,
      "degeneration:loop",
      "degeneration",
      1
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("stuck");
    expect(result?.reason).toBe("handoff");
  });

  test("timeout has one recovery attempt", () => {
    let result = settleSyntheticBlock(ctx, state, "timeout:api", "timeout", 1);

    expect(result).toBeNull(); // First attempt succeeds

    result = settleSyntheticBlock(ctx, state, "timeout:api", "timeout", 2);
    expect(result?.status).toBe("stuck"); // Second attempt exhausts budget
  });
});
