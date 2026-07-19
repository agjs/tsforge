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
  maxGatePhase,
} from "../src/loop/turn";
import type { IValidateResult } from "../src/validate";

// WS-B phase robustness (panel critical): the frontier signal must survive the meta errors
// evaluateGate ALWAYS appends. commonGatePhase() collapses to undefined the moment any
// error is unphased; maxGatePhase() takes the furthest PHASED error, ignoring meta — so a
// genuine phase advance (a later-phase error present alongside meta noise) is still seen and
// NOT mistaken for a spray.
test("maxGatePhase: furthest phased error, ignoring unphased meta errors", () => {
  expect(maxGatePhase([{ key: "a", message: "m", phase: 1 }])).toBe(1);
  // Mixed phases → the max.
  expect(
    maxGatePhase([
      { key: "a", message: "m", phase: 1 },
      { key: "b", message: "m", phase: 2 },
    ])
  ).toBe(2);
  // THE FIX: a later-phase error alongside an unphased meta error → still phase 2 (not
  // undefined, as commonGatePhase would give — which made a real advance look like a spray).
  expect(
    maxGatePhase([
      { key: "meta", message: "test-sibling-required" }, // no phase
      { key: "b", message: "m", phase: 2 },
    ])
  ).toBe(2);
  // No phased error at all → undefined (fall back to count-based).
  expect(maxGatePhase([{ key: "meta", message: "m" }])).toBeUndefined();
  expect(maxGatePhase([])).toBeUndefined();
});

// WS-B end-to-end: with the flag ON, a build that reaches near-green (1 error) then SPRAYS
// (8 errors) must REVERT the scope files to the near-green best; with the flag OFF the path
// is unchanged (no revert). Driven through the real settleGate integration.

const FLAG = "TSFORGE_NEAR_GREEN_CHECKPOINT";

afterEach(() => {
  delete process.env.TSFORGE_NEAR_GREEN_CHECKPOINT;
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
  process.env[FLAG] = "1";
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
      tool: {},
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

    // Checkpoint the near-green state (feature.ts = GOOD, 1 error).
    const checkpoint = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "e0", message: "the one remaining error" },
    ]);

    // A spray then CREATED extra.ts and inflated every convergence guard.
    await Bun.write(join(dir, "extra.ts"), "export const BAD = 1;\n");
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
  process.env[FLAG] = "1";
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
  process.env[FLAG] = "1";
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // Checkpoint at phase 1 (1 error), then the model advances the frontier — a phase-2 error
  // appears ALONGSIDE an unphased meta error and the count grows to 8. commonGatePhase would
  // read undefined here and revert real progress; maxGatePhase sees phase 2 > 1 → no revert.
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

test("flag OFF (default): the SAME spray is NOT reverted — no path change", async () => {
  // FLAG unset → default off.
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
