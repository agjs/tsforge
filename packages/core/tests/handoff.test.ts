import { describe, it, expect } from "bun:test";
import {
  buildHandoffAsk,
  checkStuck,
  type ILoopCtx,
  type ILoopState,
} from "../src/loop/turn";
import { STUCK_REASON, RUN_STATUS } from "../src/loop/loop.constants";
import type { IErrorItem } from "../src/validate";
import { commandGate } from "../src/gate/gate-runner";

describe("buildHandoffAsk", () => {
  it("derives a non-empty ask from a steer and error set", () => {
    const finalSteer =
      "The linter keeps catching unsafe type patterns. Read the error messages below, identify the root mismatch, and try a fundamentally different type strategy.";
    const persistingErrors = [
      "src/index.ts:no-unsafe-argument",
      "src/types.ts:no-explicit-any",
    ];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
    expect(ask).toContain("unsafe");
  });

  it("handles empty error list gracefully", () => {
    const finalSteer = "Make progress on the blocking issue.";
    const persistingErrors: string[] = [];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
  });

  it("handles empty steer gracefully", () => {
    const finalSteer = "";
    const persistingErrors = ["src/index.ts:some-rule"];

    const ask = buildHandoffAsk(finalSteer, persistingErrors);

    expect(ask).toBeTruthy();
    expect(ask.length).toBeGreaterThan(0);
  });

  it("is pure (same inputs give same output)", () => {
    const steer = "Reset and try a different approach.";
    const errors = ["file.ts:rule1", "file.ts:rule2"];

    const ask1 = buildHandoffAsk(steer, errors);
    const ask2 = buildHandoffAsk(steer, errors);

    expect(ask1).toBe(ask2);
  });
});

describe("checkStuck — integration: ladder exhaustion → handoff", () => {
  // Minimal error item factory
  function err(key: string, message = key, rule = "test-rule"): IErrorItem {
    return { key, message, rule };
  }

  // Minimal ILoopCtx factory for testing
  function mockCtx(): ILoopCtx {
    const events: any[] = [];
    const task = { id: "test-task", files: ["src/**/*.ts"], accept: "" };

    return {
      task,
      cwd: "/test",
      tsService: null,
      report: (event) => events.push(event),
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(task, undefined),
      },
    };
  }

  // Minimal ILoopState factory
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
      blockFingerprint: "",
      recentGateFingerprints: [],
      triedLeversByBlock: new Map(),
      pendingRung: null,
      pendingBlockFingerprint: null,
      pendingDiagnosisSteer: null,
      focusError: null,
      pendingModelOverride: null,
    };
  }

  it("exhausts the steering ladder and returns a stuck result with handoff", () => {
    const ctx = mockCtx();
    const state = freshState();

    // Persistent error that will trigger samePersist guard
    const persistentError = err("src/index.ts:no-explicit-any");
    const gateErrors = [persistentError];

    let turn = 1;
    let result = null;

    // Drive the ladder exhaustion: each guard trip escalates steerLevel,
    // and we continue cycles with the same error until steerLevel > STEER_LADDER_MAX.
    // samePersist guard trips when age >= LOOP_LIMITS.samePersist (5 by default).
    const maxCycles = 100; // Safety limit

    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      // Call checkStuck, which increments errorAge via trackErrorAges
      result = checkStuck(ctx, state, gateErrors, turn);
      turn += 1;

      // If stuck, we're done
      if (result !== null && result.status === RUN_STATUS.stuck) {
        break;
      }
    }

    // Verify the result is stuck with handoff
    expect(result).not.toBeNull();
    expect(result?.status).toBe(RUN_STATUS.stuck);
    expect(result?.reason).toBe(STUCK_REASON.handoff);
    expect(result?.handoff).toBeDefined();

    // Verify handoff structure
    const handoff = result?.handoff;

    expect(handoff?.block).toBeTruthy();
    expect(handoff?.rungHistory).toBeDefined();
    expect(Array.isArray(handoff?.rungHistory)).toBe(true);
    expect(handoff?.errors).toBeDefined();
    expect(Array.isArray(handoff?.errors)).toBe(true);
    expect(handoff?.ask).toBeTruthy();
    expect(handoff?.resumable).toBe(true);
    expect(handoff?.resume).toBeDefined();
  });
});
