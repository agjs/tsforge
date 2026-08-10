import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  announceTaskDone,
  settleGate,
  type ILoopCtx,
  type ILoopState,
} from "../src/loop/turn";
import type { ILoopEvent } from "../src/loop";
import type { IValidateResult } from "../src/validate";
import { RUN_STATUS } from "../src/loop/loop.constants";

function baseState(over: Partial<ILoopState> = {}): ILoopState {
  return {
    prevGateErrors: [
      {
        key: "src/lib/random.ts:test-sibling-required",
        message: "Missing test for a logic file you changed",
      },
    ],
    gateNoProgress: 3,
    bestErrorCount: 1,
    noNewLow: 2,
    errorAge: new Map([["src/lib/random.ts:test-sibling-required", 4]]),
    lastGateCount: 1,
    edits: 5,
    regressions: 0,
    ttsrInterrupts: 0,
    steerLevel: 0,
    lastFailureClass: "lint-rule",
    lastFailureDetail: "test-sibling-required",
    ...over,
  };
}

test("settleGate GREEN clears stale prevGateErrors (no ghost outstanding after continue)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-green-clear-"));
  const events: ILoopEvent[] = [];

  try {
    await Bun.write(join(dir, "a.ts"), "export const x = 1;\n");

    const ctx: ILoopCtx = {
      task: {
        id: "session",
        intent: "test",
        accept: "",
        files: ["**/*"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: (e) => {
        events.push(e);
      },
      messages: [],
      tool: { touched: new Set(["a.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => ({
            passed: true,
            errors: [],
            output: "",
          }),
        },
      },
    };

    const state = baseState();
    const result = await settleGate(ctx, state, 42);

    expect(result?.status).toBe(RUN_STATUS.done);
    expect(state.prevGateErrors).toEqual([]);
    expect(state.errorAge.size).toBe(0);
    expect(state.lastFailureClass).toBeUndefined();
    expect(state.lastFailureDetail).toBeUndefined();
    // Phase B may still continue — settle must not claim the run is finished.
    expect(events.some((e) => e.kind === "done")).toBe(false);
    expect(
      events.some((e) => e.kind === "validated" && e.passed === true)
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("announceTaskDone is the only path that emits kind:done after a green settle", () => {
  const events: ILoopEvent[] = [];

  announceTaskDone((e) => events.push(e), "session", 12);

  expect(events).toEqual([
    {
      kind: "done",
      task: "session",
      cycles: 12,
      message: "task session: done in 12 turn(s)",
    },
  ]);
});
