import { test, expect, describe } from "bun:test";
import {
  fingerprintFor,
  isTrivialDiagnosis,
  trackErrorAges,
} from "../src/loop/turn";
import type { ILoopState } from "../src/loop/turn";
import type { IErrorItem } from "../src/validate";

const err = (key: string, message = key): IErrorItem => ({ key, message });

// Minimal ILoopState factory — fill only what fingerprintFor reads.
function state(over: Partial<ILoopState> = {}): ILoopState {
  const defaults: ILoopState = {
    prevGateErrors: [],
    gateNoProgress: 0,
    bestErrorCount: 99,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: 0,
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

  return { ...defaults, ...over };
}

describe("fingerprintFor", () => {
  test("oscillating error SET yields a STABLE fingerprint, not novel each cycle", () => {
    // A↔B alternation: sameErrorSet reads 'moved' each cycle, but the plateau
    // branch over the window must produce the SAME string both ways.
    const key0 = "src/a.ts:rule-x";
    const key1 = "src/b.ts:rule-y";
    const s1 = state({
      redGates: 4,
      plateauBest: 3,
      recentGateFingerprints: [key0, key1, key0, key1],
    });
    const fpA = fingerprintFor(s1, [err(key0)]);
    const fpB = fingerprintFor(s1, [err(key1)]);

    expect(fpA).toBe(fpB);
    expect(fpA).not.toBe("");
  });

  test("a single persisted key (samePersist) fingerprints to that key", () => {
    const key = "src/x.ts:no-unsafe-argument";
    const s = state({
      errorAge: new Map([[key, 5]]), // Seed age directly: age 5 = threshold for samePersist
    });

    expect(fingerprintFor(s, [err(key)])).toBe(key);
  });

  test("no active stall → empty string", () => {
    expect(fingerprintFor(state(), [])).toBe("");
  });

  test("genuine resolution (new low) produces a DIFFERENT fingerprint than the stall", () => {
    const stalled = fingerprintFor(
      state({
        redGates: 4,
        plateauBest: 3,
        recentGateFingerprints: ["src/a.ts:rule-x"],
      }),
      [err("src/a.ts:rule-x")]
    );
    const resolved = fingerprintFor(state({ bestErrorCount: 0 }), []);

    expect(resolved).not.toBe(stalled);
  });

  test("fingerprintFor is pure: calling twice with same inputs yields same result and no mutation", () => {
    const key = "src/x.ts:rule-a";
    const s = state({
      errorAge: new Map([[key, 5]]),
    });
    const snapshot = new Map(s.errorAge); // Capture before

    const fp1 = fingerprintFor(s, [err(key)]);
    const fp2 = fingerprintFor(s, [err(key)]); // Call again with same inputs

    // Same fingerprint both times
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(key);

    // errorAge unchanged (no mutation)
    expect(s.errorAge).toEqual(snapshot);
  });

  test("trackErrorAges followed by fingerprintFor reads the incremented age without double-advancing", () => {
    const key = "src/x.ts:rule-b";
    const s = state();

    // Seed initial age = 4 (one short of persistence threshold)
    s.errorAge.set(key, 4);

    // trackErrorAges increments age to 5
    trackErrorAges(s, [err(key)]);

    // fingerprintFor reads the age without incrementing further
    const fp = fingerprintFor(s, [err(key)]);

    // Fingerprint is the key (age 5 = threshold)
    expect(fp).toBe(key);

    // Age stays 5, not double-incremented to 6
    expect(s.errorAge.get(key)).toBe(5);
  });

  test("samePersist below threshold does not yield a fingerprint", () => {
    const key = "src/x.ts:rule-c";
    const s = state({
      errorAge: new Map([[key, 4]]), // Below threshold (5)
    });

    const fp = fingerprintFor(s, [err(key)]);

    // No samePersist stall yet
    expect(fp).toBe("");
  });
});

describe("isTrivialDiagnosis", () => {
  test("short output is trivial", () => {
    expect(isTrivialDiagnosis("nope", [err("a:b")])).toBe(true);
  });
  test("output that only restates the errors is trivial", () => {
    expect(
      isTrivialDiagnosis("the error a:b is still failing", [err("a:b", "a:b")])
    ).toBe(true);
  });
  test("a substantive genuinely-different hypothesis is NOT trivial", () => {
    const diag =
      "The root cause is that the type guard narrows on the wrong discriminant; " +
      "I should switch to narrowing on `kind` and construct the value from a factory instead.";

    expect(isTrivialDiagnosis(diag, [err("a:b")])).toBe(false);
  });
});
