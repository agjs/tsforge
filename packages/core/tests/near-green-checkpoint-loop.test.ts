import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { IGate } from "../src/gate/gate-runner";
import type { ILoopCtx, ILoopState } from "../src/loop/turn";
import {
  captureNearGreenCheckpoint,
  rollbackNearGreen,
  phasedCommonPhase,
} from "../src/loop/turn";
import type { IValidateResult } from "../src/validate";
import { MAX_NEAR_GREEN_ROLLBACKS } from "../src/loop/near-green-checkpoint";

// WS-B phase signal: the COMMON phase over the PHASED errors, ignoring the unphased meta
// evaluateGate appends. Survives meta (unlike commonGatePhase, which collapses to undefined
// next to any unphased error) AND does not misread a MIXED-phase result (BoringStack tags
// phase by file path — api=1, ui=2 — in one result) as its highest phase (which a max-over-
// phases would, wrongly wiping a near-green api checkpoint when a ui error appears).
test("phasedCommonPhase: common phase of phased errors; meta ignored; mixed → undefined", () => {
  expect(phasedCommonPhase([{ key: "a", message: "m", phase: 1 }])).toBe(1);
  // A single phase alongside unphased meta → that phase (meta ignored).
  expect(
    phasedCommonPhase([
      { key: "meta", message: "test-sibling-required" }, // no phase
      { key: "b", message: "m", phase: 2 },
    ])
  ).toBe(2);
  // MIXED phased errors (api=1 + ui=2 in one result) → undefined → conservative count-based,
  // NOT a wrongful "advanced to phase 2" that would wipe a phase-1 checkpoint.
  expect(
    phasedCommonPhase([
      { key: "a", message: "m", phase: 1 },
      { key: "b", message: "m", phase: 2 },
    ])
  ).toBeUndefined();
  // No phased error at all → undefined (fall back to count-based).
  expect(phasedCommonPhase([{ key: "meta", message: "m" }])).toBeUndefined();
  expect(phasedCommonPhase([])).toBeUndefined();
});

// WS-B end-to-end: with the flag ON, a build that reaches near-green (1 error) then SPRAYS
// (8 errors) must REVERT the scope files to the near-green best; with the flag OFF the path
// is unchanged (no revert). Driven through the real settleGate integration.

// WS-B is DEFAULT ON — the tests below run it without any env. KILL is the kill-switch the
// "disabled" test sets to turn it off.
const KILL = "TSFORGE_NO_NEAR_GREEN_CHECKPOINT";

afterEach(() => {
  delete process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT;
});

/** A gate whose error count depends on the file the model wrote: content with "BAD" = an
 *  8-error spray; anything else = the 1-error near-green state. Never green, so the drive
 *  runs long enough to checkpoint then spray. */
function contentAwareGate(dir: string): IGate {
  return {
    run: async () => {
      let content: string;

      try {
        content = await Bun.file(join(dir, "feature.ts")).text();
      } catch {
        content = "";
      }

      const n = content.includes("BAD") ? 8 : 1;

      return {
        passed: false,
        errors: Array.from({ length: n }, (_, i) => ({
          key: `e${String(i)}`,
          message: `error ${String(i)}`,
        })),
        output: `${String(n)} error(s)`,
      };
    },
  };
}

/** Writes the near-green file, yields to gate it, sprays a BAD file, yields to gate it,
 *  then just yields — so after any revert no further BAD edit re-dirties the tree. */
function nearGreenThenSpray(): IProvider {
  let n = 0;

  return {
    async complete() {
      n += 1;

      if (n === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "create",
              arguments: {
                file: "feature.ts",
                content: "export const GOOD = 1;\n",
              },
            },
          ],
        };
      }

      if (n === 3) {
        // `create` won't overwrite a parseable file — edit the near-green file into the
        // spray state instead (GOOD → BAD).
        return {
          content: "",
          toolCalls: [
            {
              id: "c2",
              name: "edit",
              arguments: {
                file: "feature.ts",
                oldString: "GOOD",
                newString: "BAD",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };
}

test("flag ON: a spray past the near-green checkpoint REVERTS the file to the best state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: nearGreenThenSpray(),
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // The rollback fired (a distinctive tool event) …
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(true);
    // … and the on-disk file was restored to the near-green best — the spray is gone.
    const final = await Bun.file(join(dir, "feature.ts")).text();

    expect(final).toContain("GOOD");
    expect(final).not.toContain("BAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("rollbackNearGreen resets the convergence guards + tombstones, without touching the ladder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));

  try {
    await Bun.write(join(dir, "feature.ts"), "export const GOOD = 1;\n");

    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        files: ["**/*"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: () => undefined,
      messages: [],
      tool: { touched: new Set(["a.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => ({
            passed: false,
            errors: [],
            output: "",
          }),
        },
      },
    };

    // Checkpoint the near-green state (feature.ts = GOOD, 1 error, touched = {a.ts}).
    const checkpoint = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "e0", message: "the one remaining error" },
    ]);

    // A spray then CREATED extra.ts, touched a NEW file (b.ts), and inflated every guard.
    await Bun.write(join(dir, "extra.ts"), "export const BAD = 1;\n");
    ctx.tool.touched?.add("b.ts");
    const state: ILoopState = {
      prevGateErrors: [{ key: "spray", message: "spray error" }],
      gateNoProgress: 5,
      bestErrorCount: 8,
      noNewLow: 5,
      redGates: 5,
      errorAge: new Map([["spray", 4]]),
      lastGateCount: 8,
      edits: 10,
      regressions: 3,
      ttsrInterrupts: 0,
      steerLevel: 2,
      conventionsEnabled: false,
      blockFingerprint: "block-x",
      plateauBest: 1,
      pendingDiagnosisSteer: "stale R1 diagnosis from the spray cycle",
      pendingSteer: "stale R2/R3 steer from the spray cycle",
      nearGreenCheckpoint: checkpoint,
      nearGreenRollbacks: 0,
    };

    await rollbackNearGreen(ctx, state, 8);

    // The convergence guards are reset to the RESTORED near-green state, so checkStuck can't
    // fire the plateau/persist guard on the first post-revert cycle.
    expect(state.gateNoProgress).toBe(0);
    expect(state.noNewLow).toBe(0);
    expect(state.redGates).toBe(0);
    expect(state.errorAge.size).toBe(0);
    expect(state.bestErrorCount).toBe(1);
    expect(state.lastGateCount).toBe(1);
    expect(state.prevGateErrors).toEqual([...checkpoint.errors]);
    expect(state.nearGreenRollbacks).toBe(1);
    // A revert is NOT a new block and NOT ladder progress — these are left untouched.
    expect(state.steerLevel).toBe(2);
    expect(state.blockFingerprint).toBe("block-x");
    expect(state.plateauBest).toBe(1);
    // The spray was reverted, so it's not a real regression of the metric — undone.
    expect(state.regressions).toBe(2);
    // BOTH stale steers from the spray cycle are cleared (injectFeedback reads
    // pendingDiagnosisSteer ?? pendingSteer, and the rollback path skips injectFeedback).
    expect(state.pendingDiagnosisSteer).toBeNull();
    expect(state.pendingSteer).toBeUndefined();
    // The change-scoping set is restored to the checkpoint's — the spray-touched b.ts is gone.
    expect([...(ctx.tool.touched ?? [])].sort()).toEqual(["a.ts"]);
    // The spray-created file is tombstoned; the near-green file restored.
    expect(await Bun.file(join(dir, "extra.ts")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "feature.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A gate that sprays (8 errors) iff a spray-marker file exists, else near-green (1). Lets
 *  us prove that a spray which CREATES a new file is fully reverted — the file tombstoned. */
function existenceGate(dir: string): IGate {
  return {
    run: async () => {
      const sprayed = await Bun.file(join(dir, "extra.ts")).exists();
      const n = sprayed ? 8 : 1;

      return {
        passed: false,
        errors: Array.from({ length: n }, (_, i) => ({
          key: `e${String(i)}`,
          message: `error ${String(i)}`,
        })),
        output: `${String(n)} error(s)`,
      };
    },
  };
}

test("flag ON: a spray that CREATES a new file is reverted — the file is tombstoned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // turn 1 create feature.ts (near-green, checkpointed); turn 3 create a NEW extra.ts (the
  // spray); then yield. A plain content-map restore would leave extra.ts on disk (gate stays
  // sprayed → thrash); the shared IFileSnapshot substrate tombstones it.
  let n = 0;
  const provider: IProvider = {
    async complete() {
      n += 1;

      if (n === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "create",
              arguments: {
                file: "feature.ts",
                content: "export const GOOD = 1;\n",
              },
            },
          ],
        };
      }

      if (n === 3) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c2",
              name: "create",
              arguments: {
                file: "extra.ts",
                content: "export const BAD = 1;\n",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate: existenceGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(true);
    // The spray-created file was TOMBSTONED — not left on disk keeping the gate sprayed.
    expect(await Bun.file(join(dir, "extra.ts")).exists()).toBe(false);
    // The near-green file survives.
    expect(await Bun.file(join(dir, "feature.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

/** A phase-aware gate: once the advance marker (extra.ts) exists it returns a LATER-phase
 *  error alongside an UNPHASED meta error (the shape evaluateGate produces); before that,
 *  a single phase-1 error. Proves a genuine frontier advance isn't mistaken for a spray. */
function phaseAdvanceGate(dir: string): IGate {
  return {
    run: async (): Promise<IValidateResult> => {
      const advanced = await Bun.file(join(dir, "extra.ts")).exists();

      if (advanced) {
        return {
          passed: false,
          errors: [
            { key: "p2", message: "phase 2 error", phase: 2 },
            { key: "meta", message: "test-sibling-required" }, // unphased meta
            ...Array.from({ length: 6 }, (_, i) => ({
              key: `x${String(i)}`,
              message: `error ${String(i)}`,
              phase: 2,
            })),
          ],
          output: "8 error(s)",
        };
      }

      return {
        passed: false,
        errors: [{ key: "p1", message: "phase 1 error", phase: 1 }],
        output: "1 error",
      };
    },
  };
}

test("flag ON: a genuine FRONTIER ADVANCE (later phase + meta) is NOT rolled back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // Checkpoint at phase 1 (1 error), then the model advances the frontier — phase-2 errors
  // appear ALONGSIDE an unphased meta error and the count grows to 8. commonGatePhase would
  // read undefined here and revert real progress; phasedCommonPhase sees phase 2 > 1 → no revert.
  let n = 0;
  const provider: IProvider = {
    async complete() {
      n += 1;

      if (n === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "create",
              arguments: {
                file: "feature.ts",
                content: "export const GOOD = 1;\n",
              },
            },
          ],
        };
      }

      if (n === 3) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c2",
              name: "create",
              arguments: {
                file: "extra.ts",
                content: "export const NEXT = 1;\n",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate: phaseAdvanceGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // No rollback — the frontier advance is progress, not a spray.
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(false);
    // The phase-2 work survives on disk (not reverted to the phase-1 snapshot).
    expect(await Bun.file(join(dir, "extra.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "feature.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

/** A 3-state phase-2 gate keyed by marker files: before `advanced.ts` → phase-1 near-green
 *  (1); with `advanced.ts` but not `fixed.ts` → phase-2 landing ABOVE near-green (8); with
 *  `fixed.ts` → phase-2 near-green (1); with `sprayed.ts` → phase-2 spray (8). All phase-2
 *  states carry an unphased meta error (the evaluateGate shape). */
function multiPhaseGate(dir: string): IGate {
  const exists = (f: string): Promise<boolean> =>
    Bun.file(join(dir, f)).exists();
  const phase2 = (count: number): IValidateResult => ({
    passed: false,
    errors: [
      { key: "meta", message: "test-sibling-required" }, // unphased meta
      ...Array.from({ length: count }, (_, i) => ({
        key: `p2_${String(i)}`,
        message: `phase 2 error ${String(i)}`,
        phase: 2,
      })),
    ],
    output: `${String(count)} error(s)`,
  });

  return {
    run: async (): Promise<IValidateResult> => {
      if (!(await exists("advanced.ts"))) {
        return {
          passed: false,
          errors: [{ key: "p1", message: "phase 1 error", phase: 1 }],
          output: "1 error",
        };
      }

      if (await exists("sprayed.ts")) {
        return phase2(8);
      }

      if (await exists("fixed.ts")) {
        return phase2(1);
      }

      return phase2(8); // the advance itself lands above near-green
    },
  };
}

test("flag ON: WS-B stays armed across a MULTI-PHASE run — a phase-2 spray is reverted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // phase-1 near-green (checkpoint) → advance to phase-2 above near-green (stale checkpoint
  // invalidated, no revert) → phase-2 near-green (RE-checkpoint via needsReArm) → phase-2
  // spray (must revert to the phase-2 checkpoint). This is the inert-after-advance case.
  const create = (id: string, file: string) => ({
    content: "",
    toolCalls: [
      {
        id,
        name: "create",
        arguments: { file, content: `export const X = 1;\n` },
      },
    ],
  });
  let n = 0;
  const provider: IProvider = {
    async complete() {
      n += 1;

      if (n === 1) {
        return create("a", "feature.ts");
      } // phase-1 near-green

      if (n === 3) {
        return create("b", "advanced.ts");
      } // advance to phase 2 (count 8)

      if (n === 5) {
        return create("c", "fixed.ts");
      } // phase-2 near-green

      if (n === 7) {
        return create("d", "sprayed.ts");
      } // phase-2 spray

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate: multiPhaseGate(dir),
      maxTurns: 16,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // WS-B re-armed at phase 2 and reverted the phase-2 spray — NOT inert after the advance.
    const rollbacks = events.filter(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    ).length;

    expect(rollbacks).toBeGreaterThanOrEqual(1);
    // The phase-2 spray file was tombstoned; the phase-2 near-green files survive.
    expect(await Bun.file(join(dir, "sprayed.ts")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "fixed.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "advanced.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("flag ON: the checkpoint REFRESHES to a strictly better near-green count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // The independence-from-plateauBest path: phase-1 near-green (plateauBest=1) → META-bearing
  // advance to PHASE 2 count 2 (commonGatePhase=undefined, so checkStuck NEVER rebases
  // plateauBest — it stays 1) → phase-2 improves to count 1. Under the old `curr < plateauBest`
  // rule that's `1 < 1` = false → NO refresh, and a spray would revert to the WORSE count-2
  // snapshot. nearGreenBest (=2) sees `1 < 2` → refresh@1, so the spray reverts to count 1 and
  // improved.ts survives. This ONLY passes with the nearGreenBest watermark.
  const p1 = (): IValidateResult => ({
    passed: false,
    errors: [{ key: "p1", message: "phase 1 error", phase: 1 }],
    output: "1 error",
  });
  const p2 = (count: number, meta: boolean): IValidateResult => ({
    passed: false,
    errors: [
      ...(meta ? [{ key: "meta", message: "test-sibling-required" }] : []),
      ...Array.from({ length: count - (meta ? 1 : 0) }, (_, i) => ({
        key: `p2_${String(i)}`,
        message: `phase 2 error ${String(i)}`,
        phase: 2,
      })),
    ],
    output: `${String(count)} error(s)`,
  });
  const has = (f: string): Promise<boolean> => Bun.file(join(dir, f)).exists();
  const gate: IGate = {
    run: async (): Promise<IValidateResult> => {
      if (!(await has("advanced.ts"))) {
        return p1();
      }

      if (await has("sprayed.ts")) {
        return p2(8, true);
      }

      if (await has("improved.ts")) {
        return p2(1, false);
      } // pure phase-2, count 1

      return p2(2, true); // META-bearing advance, count 2 → plateauBest can't rebase
    },
  };
  const create = (id: string, file: string) => ({
    content: "",
    toolCalls: [
      {
        id,
        name: "create",
        arguments: { file, content: "export const X = 1;\n" },
      },
    ],
  });
  let n = 0;
  const provider: IProvider = {
    async complete() {
      n += 1;

      if (n === 1) {
        return create("a", "feature.ts");
      } // phase-1 near-green → checkpoint@p1

      if (n === 3) {
        return create("b", "advanced.ts");
      } // phase-2 count 2 → re-arm@p2 count 2

      if (n === 5) {
        return create("c", "improved.ts");
      } // phase-2 count 1 → REFRESH@p2 count 1

      if (n === 7) {
        return create("d", "sprayed.ts");
      } // phase-2 count 8 → revert to count 1

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate,
      maxTurns: 14,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(true);
    expect(await Bun.file(join(dir, "sprayed.ts")).exists()).toBe(false);
    // improved.ts survives → the checkpoint refreshed to the count-1 state, not the count-2.
    expect(await Bun.file(join(dir, "improved.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("WS-B bounds TOTAL reverts per drive — the (MAX+1)th spray is NOT reverted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // The model oscillates forever: reach near-green (GOOD, 1) → spray (BAD, 8) → revert →
  // repeat. WS-B must revert at most MAX_NEAR_GREEN_ROLLBACKS times, then STOP (hand the
  // stall to the ladder) — else a pathological build thrashes to maxTurns.
  let n = 0;
  const provider: IProvider = {
    async complete() {
      n += 1;

      if (n === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "create",
              arguments: { file: "feature.ts", content: "const GOOD = 1;\n" },
            },
          ],
        };
      }

      // Odd turns after the first: spray (GOOD → BAD); even turns: yield to gate it. After a
      // revert the file is GOOD again, so the same edit re-sprays each cycle.
      if (n % 2 === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: `s${String(n)}`,
              name: "edit",
              arguments: {
                file: "feature.ts",
                oldString: "GOOD",
                newString: "BAD",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 40,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    const rollbacks = events.filter(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    ).length;

    // Reverts are capped — WS-B gives up after the budget, it does not thrash forever.
    expect(rollbacks).toBe(MAX_NEAR_GREEN_ROLLBACKS);
    // …and it really STOPS reverting: after the budget the spray is left on disk (BAD),
    // not silently reverted while just suppressing the event.
    expect(await Bun.file(join(dir, "feature.ts")).text()).toContain("BAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a SECOND drive after budget exhaustion gets a FRESH revert budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // Two sends. Each drive: ensure GOOD → yield (checkpoint) → spray/yield…. Drive 1 exhausts
  // the budget (MAX reverts). Drive 2 must get a FRESH budget (proving the per-drive reset in
  // driveInner / resetDriveConvergence) and revert again — else the budget leaked and WS-B
  // would be dead for the rest of the session.
  const countRollbacks = (): number =>
    events.filter(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    ).length;
  let t = 0;
  const provider: IProvider = {
    async complete() {
      t += 1;

      if (t === 1) {
        // Ensure the near-green file exists as GOOD (create first time, else un-spray it).
        if (await Bun.file(join(dir, "feature.ts")).exists()) {
          return {
            content: "",
            toolCalls: [
              {
                id: `g${String(t)}`,
                name: "edit",
                arguments: {
                  file: "feature.ts",
                  oldString: "BAD",
                  newString: "GOOD",
                },
              },
            ],
          };
        }

        return {
          content: "",
          toolCalls: [
            {
              id: "g0",
              name: "create",
              arguments: { file: "feature.ts", content: "const GOOD = 1;\n" },
            },
          ],
        };
      }

      // odd t → spray (GOOD → BAD); even t → yield to gate it.
      if (t % 2 === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: `s${String(t)}`,
              name: "edit",
              arguments: {
                file: "feature.ts",
                oldString: "GOOD",
                newString: "BAD",
              },
            },
          ],
        };
      }

      return { content: "working", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 40,
      report: (e) => events.push(e),
    });

    t = 0;
    await session.send("build it"); // drive 1: exhaust the budget
    const drive1 = countRollbacks();

    t = 0;
    await session.send("keep going"); // drive 2: fresh budget
    const total = countRollbacks();

    expect(drive1).toBe(MAX_NEAR_GREEN_ROLLBACKS); // drive 1 hit the cap
    expect(total).toBeGreaterThan(drive1); // drive 2 reverted again → fresh per-drive budget
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("kill-switch: with WS-B disabled, the SAME spray is NOT reverted — no path change", async () => {
  process.env[KILL] = "1"; // TSFORGE_NO_NEAR_GREEN_CHECKPOINT → WS-B off
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: nearGreenThenSpray(),
      cwd: dir,
      files: ["**/*"],
      gate: contentAwareGate(dir),
      maxTurns: 12,
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // No rollback event, and the sprayed file was left as the model wrote it (BAD).
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(false);
    const final = await Bun.file(join(dir, "feature.ts")).text();

    expect(final).toContain("BAD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
