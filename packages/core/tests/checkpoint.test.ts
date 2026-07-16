import { describe, test, expect } from "bun:test";
import type { ILoopState } from "../src/loop/turn";
import {
  serializeLoopState,
  deserializeLoopState,
} from "../src/loop/checkpoint";

describe("checkpoint serialization (DTOs)", () => {
  test("round-trips ILoopState with populated Map and Set fields", () => {
    // Build a state with Map/Set fields that JSON.stringify would flatten
    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 5,
      noNewLow: 0,
      errorAge: new Map([
        ["src/index.ts:no-unused-vars", 3],
        ["src/lib/util.ts:strict-null", 2],
      ]),
      lastGateCount: 5,
      edits: 10,
      regressions: 1,
      ttsrInterrupts: 0,
      steerLevel: 1,
      pendingSteer: "try a different approach",
      resetContext: false,
      pushedGuides: new Set(["convention-1", "convention-2"]),
      conventionsEnabled: true,
      redGates: 0,
      plateauBest: 5,
      blockFingerprint: "src/index.ts:no-unused-vars",
      recentGateFingerprints: ["src/index.ts:no-unused-vars"],
      triedLeversByBlock: new Map([
        ["src/index.ts:no-unused-vars", new Set(["R1", "R2"])],
      ]),
      pendingRung: "R3",
      pendingBlockFingerprint: "src/index.ts:no-unused-vars",
      pendingDiagnosisSteer: undefined,
      focusError: "src/index.ts:no-unused-vars",
      pendingModelOverride: {
        temperature: 0.5,
        reasoningEffort: "high",
        enableThinking: true,
        thinkingTokenBudget: 4096,
      },
    };

    const serialized = serializeLoopState(state);
    const deserialized = deserializeLoopState(serialized);

    // Verify Maps/Sets are restored, not stringified to {}
    expect(deserialized.errorAge).toBeInstanceOf(Map);
    expect(deserialized.errorAge.get("src/index.ts:no-unused-vars")).toBe(3);
    expect(deserialized.errorAge.get("src/lib/util.ts:strict-null")).toBe(2);

    expect(deserialized.pushedGuides).toBeInstanceOf(Set);
    expect(Array.from(deserialized.pushedGuides ?? [])).toContain(
      "convention-1"
    );
    expect(Array.from(deserialized.pushedGuides ?? [])).toContain(
      "convention-2"
    );

    expect(deserialized.triedLeversByBlock).toBeInstanceOf(Map);

    const tried = deserialized.triedLeversByBlock?.get(
      "src/index.ts:no-unused-vars"
    );

    expect(tried).toBeInstanceOf(Set);
    expect(Array.from(tried ?? [])).toEqual(["R1", "R2"]);

    // Verify scalar fields
    expect(deserialized.steerLevel).toBe(1);
    expect(deserialized.blockFingerprint).toBe("src/index.ts:no-unused-vars");
    expect(deserialized.pendingRung).toBe("R3");
    expect(deserialized.focusError).toBe("src/index.ts:no-unused-vars");
    expect(deserialized.pendingModelOverride?.temperature).toBe(0.5);
  });

  test("handles undefined optional fields correctly", () => {
    const state: ILoopState = {
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
      // Optional fields all undefined
    };

    expect(state.blockFingerprint).toBeUndefined();
    expect(state.triedLeversByBlock).toBeUndefined();
    expect(state.pendingDiagnosisSteer).toBeUndefined();
  });
});
