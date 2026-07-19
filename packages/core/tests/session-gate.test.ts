import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import type { IGate } from "../src/gate/gate-runner";
import { Session } from "../src/loop";
import { forcedGateInterval, resetDriveConvergence } from "../src/loop/session";
import type { ILoopState } from "../src/loop";

function loopState(over: Partial<ILoopState>): ILoopState {
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
    ...over,
  };
}

test("forcedGateInterval: dense gating when near-green or stalling, else the default", () => {
  // Before the first gate (lastGateCount -1) and when far from green → default (9).
  expect(forcedGateInterval(loopState({ lastGateCount: -1 }))).toBe(9);
  expect(forcedGateInterval(loopState({ lastGateCount: 20 }))).toBe(9);
  // Near-green (a small, non-zero error count) → dense (2) so the ladder can climb.
  expect(forcedGateInterval(loopState({ lastGateCount: 1 }))).toBe(2);
  expect(forcedGateInterval(loopState({ lastGateCount: 3 }))).toBe(2);
  // Already stalling (steer ladder started), even with many errors → dense (2).
  expect(
    forcedGateInterval(loopState({ lastGateCount: 20, steerLevel: 1 }))
  ).toBe(2);
});

test("resetDriveConvergence gives a revisit a fresh ladder while preserving cumulative metrics", () => {
  const state = loopState({
    prevGateErrors: [{ key: "api", message: "old API block", phase: 1 }],
    gateNoProgress: 10,
    bestErrorCount: 1,
    noNewLow: 10,
    lastGateCount: 1,
    edits: 17,
    regressions: 3,
    steerLevel: 4,
    redGates: 8,
    plateauBest: 1,
    blockFingerprint: "api",
    pendingRung: "R3",
    pendingBlockFingerprint: "api",
    triedLeversByBlock: new Map([["api", new Set(["R1", "R2", "R3"])]]),
    // WS-B is per-drive — the send-boundary reset must clear its watermark + budget too.
    nearGreenBest: 1,
    nearGreenRollbacks: 3,
  });

  resetDriveConvergence(state);

  expect(state.prevGateErrors).toEqual([]);
  expect(state.steerLevel).toBe(0);
  expect(state.blockFingerprint).toBe("");
  expect(state.triedLeversByBlock?.size).toBe(0);
  expect(state.plateauBest).toBeUndefined();
  expect(state.edits).toBe(17);
  expect(state.regressions).toBe(3);
  // WS-B per-drive state is cleared at the send boundary (not just in driveInner).
  expect(state.nearGreenBest).toBeUndefined();
  expect(state.nearGreenRollbacks).toBeUndefined();
  expect(state.nearGreenCheckpoint).toBeUndefined();
});

test("Session.setGate flips hasGate on and routes the gate through the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-gate-"));

  try {
    // Provider that creates a file on first call, then yields on second.
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };

    // A gate that fails once then passes, proving the loop calls the injected runner.
    let gateCalls = 0;
    const gate: IGate = {
      run: async () => {
        gateCalls += 1;

        return gateCalls === 1
          ? { passed: false, errors: [{ key: "x", message: "x" }], output: "x" }
          : { passed: true, errors: [], output: "ok" };
      },
    };

    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
    });

    session.setGate(gate);
    // After setGate, the session should route gate.run through the loop.
    // The loop will: (1) create file, (2) yield, (3) run gate (fail), (4) create turns until gate passes.
    const result = await session.send("create x.ts");

    // The gate was called at least once.
    expect(gateCalls).toBeGreaterThan(0);
    // After setGate injected a gate, the session should run it and report done
    // when the gate passes.
    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
