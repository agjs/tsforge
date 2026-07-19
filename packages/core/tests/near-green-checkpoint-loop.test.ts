import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
} from "../src/loop/turn";
import type { IValidateResult } from "../src/validate";
import type { IFileSnapshot } from "../src/loop/file-snapshot";
import {
  MAX_NEAR_GREEN_ROLLBACKS,
  type INearGreenCheckpoint,
} from "../src/loop/near-green-checkpoint";

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
    const checkpoint = await captureNearGreenCheckpoint(
      ctx,
      1,
      [{ key: "e0", message: "the one remaining error" }],
      0
    );

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
      pendingRung: "R2",
      pendingBlockFingerprint: "block-x",
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
    // The ladder RECORDING state is preserved too: the rung was applied on a prior cycle and
    // legitimately advanced steerLevel, so clearing pendingRung while keeping steerLevel would
    // desync them (rung never recorded tried, yet the ladder advanced → burned lever).
    expect(state.pendingRung).toBe("R2");
    expect(state.pendingBlockFingerprint).toBe("block-x");
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

test("rollbackNearGreen SURFACES snapshot.skipped files + keeps an unreverted one under enforcement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  try {
    // A checkpoint whose snapshot marked big.bin as SKIPPED (too large to back → not revertable).
    const snapshot: IFileSnapshot = {
      cwd: dir,
      scope: ["**/*"],
      existed: new Set(["big.bin", "a.ts"]),
      contents: new Map(),
      raw: new Map(),
      skipped: new Set(["big.bin"]),
    };
    const cp: INearGreenCheckpoint = {
      errorCount: 1,
      errors: [{ key: "e0", message: "one error" }],
      snapshot,
      touched: new Set(["a.ts"]), // the checkpoint's change-scope did NOT include big.bin
      editsAtCapture: 0,
    };
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
      report: (e) => events.push(e),
      messages: [],
      // The spray touched big.bin (a skipped file) AND b.ts (a normal one).
      tool: { touched: new Set(["a.ts", "b.ts", "big.bin"]) },
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
    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 8,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: 8,
      edits: 0,
      regressions: 1,
      ttsrInterrupts: 0,
      steerLevel: 0,
      nearGreenCheckpoint: cp,
      nearGreenRollbacks: 0,
    };

    await rollbackNearGreen(ctx, state, 8);

    // The incomplete revert is SURFACED (not silent) — production code reads snapshot.skipped.
    const warned = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("were NOT byte-reverted")
    );

    expect(warned).toBe(true);
    // big.bin (skipped + spray-touched, thus NOT reverted) STAYS touched so meta-rules still
    // enforce it; b.ts (revertable) is dropped back to the checkpoint's touched set {a.ts}.
    expect([...(ctx.tool.touched ?? [])].sort()).toEqual(["a.ts", "big.bin"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollbackNearGreen reverts OUT-OF-SCOPE package.json + binary lockfile (ROLLBACK_EXTRA_FILES)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "src", "feature.ts"), "export const GOOD = 1;\n");
    // Out-of-scope dependency files at their near-green (checkpoint) state.
    const pkgOrig = '{"name":"app","dependencies":{}}\n';
    const lockOrig = new Uint8Array([1, 2, 3, 250, 0, 7]); // binary bun.lockb

    await Bun.write(join(dir, "package.json"), pkgOrig);
    await Bun.write(join(dir, "bun.lockb"), lockOrig);

    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        // NARROW scope — deliberately EXCLUDES package.json / lockfiles. They are captured only
        // via ROLLBACK_EXTRA_FILES, so this proves the out-of-scope revert path.
        files: ["src/**"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: () => undefined,
      messages: [],
      tool: { touched: new Set() },
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

    const checkpoint = await captureNearGreenCheckpoint(
      ctx,
      1,
      [{ key: "e0", message: "one error" }],
      0
    );

    // A dependency spray rewrites the out-of-scope files (as add_dependency would).
    await Bun.write(
      join(dir, "package.json"),
      '{"name":"app","dependencies":{"left-pad":"1.0.0"}}\n'
    );
    await Bun.write(join(dir, "bun.lockb"), new Uint8Array([9, 9, 9]));

    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 8,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: 8,
      edits: 0,
      regressions: 1,
      ttsrInterrupts: 0,
      steerLevel: 0,
      nearGreenCheckpoint: checkpoint,
      nearGreenRollbacks: 0,
    };

    await rollbackNearGreen(ctx, state, 8);

    // Both out-of-scope files reverted to the checkpoint bytes — NOT left sprayed. The binary
    // lockfile is restored faithfully (raw bytes), the text manifest verbatim.
    expect(await Bun.file(join(dir, "package.json")).text()).toBe(pkgOrig);
    expect(
      new Uint8Array(await Bun.file(join(dir, "bun.lockb")).arrayBuffer())
    ).toEqual(lockOrig);
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

/** A gate that, once the marker (extra.ts) exists, jumps from 1 error to 8 (a later-phase
 *  error + unphased meta + 6 more — the shape evaluateGate produces); before that, a single
 *  error. Under COUNT-ONLY spray detection this +7 jump at near-green IS a spray and reverts,
 *  regardless of any error's phase — no phase exemption. */
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

test("flag ON: a big count jump at near-green IS reverted — no phase exemption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // Checkpoint at 1 error, then the count jumps to 8 with later-phase + meta errors. The old
  // phase heuristic exempted this as a "frontier advance" and let the regression survive; the
  // builder-model + panel verdict is that this masked real sprays. Count-only reverts it — the
  // accepted trade is that legitimately opening new work at near-green may be reverted once.
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

    // Count-only: the +7 jump is a spray and reverts.
    const rolledBack = events.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green rollback")
    );

    expect(rolledBack).toBe(true);
    // The spray file was tombstoned; the near-green file survives.
    expect(await Bun.file(join(dir, "extra.ts")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "feature.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("flag ON: the checkpoint REFRESHES to a strictly better near-green count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // The nearGreenBest-watermark path (count-only, phase-free): near-green at 2 (checkpoint@2,
  // nearGreenBest=2) → improves to 1 (isBetter 1<2 → REFRESH@1, snapshot now includes
  // improved.ts) → sprays to 8 (revert to the count-1 checkpoint). If WS-B failed to refresh,
  // the spray would revert to the WORSE count-2 snapshot and improved.ts would be tombstoned.
  const err = (count: number): IValidateResult => ({
    passed: false,
    errors: Array.from({ length: count }, (_, i) => ({
      key: `e${String(i)}`,
      message: `error ${String(i)}`,
    })),
    output: `${String(count)} error(s)`,
  });
  const has = (f: string): Promise<boolean> => Bun.file(join(dir, f)).exists();
  const gate: IGate = {
    run: async (): Promise<IValidateResult> => {
      if (await has("sprayed.ts")) {
        return err(8);
      }

      if (await has("improved.ts")) {
        return err(1);
      } // strictly better near-green

      return err(2); // initial near-green
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
      } // near-green 2 → checkpoint@2

      if (n === 3) {
        return create("b", "improved.ts");
      } // near-green 1 → REFRESH@1

      if (n === 5) {
        return create("c", "sprayed.ts");
      } // spray 8 → revert to count 1

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

test("flag ON: the checkpoint REFRESHES on a LATERAL same-count near-green move (1→1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));
  const events: ILoopEvent[] = [];

  // The lateral path: near-green at 1 (state A, key eA, checkpoint@1) → a DIFFERENT 1-error
  // state B (key eB — the model fixed A's error and a new one remains; count unchanged but the
  // error SET CHANGED → REFRESH so the snapshot now includes stateB.ts) → spray to 8 (revert).
  // The refresh restores B (stateB.ts survives); without the lateral refresh the checkpoint
  // would be stuck at A and the revert would TOMBSTONE stateB.ts. (The refresh fires on the
  // error-set CHANGE, not on a no-op re-settle at the identical error.)
  const one = (key: string): IValidateResult => ({
    passed: false,
    errors: [{ key, message: `error ${key}` }],
    output: "1 error(s)",
  });
  const has = (f: string): Promise<boolean> => Bun.file(join(dir, f)).exists();
  const gate: IGate = {
    run: async (): Promise<IValidateResult> => {
      if (await has("sprayed.ts")) {
        return {
          passed: false,
          errors: Array.from({ length: 8 }, (_, i) => ({
            key: `s${String(i)}`,
            message: `spray ${String(i)}`,
          })),
          output: "8 error(s)",
        };
      }

      return (await has("stateB.ts")) ? one("eB") : one("eA"); // lateral A→B (different key)
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
        return create("a", "stateA.ts");
      } // near-green 1 → checkpoint@1 (A)

      if (n === 3) {
        return create("b", "stateB.ts");
      } // still 1 (lateral) → REFRESH@1 (now includes stateB.ts)

      if (n === 5) {
        return create("c", "sprayed.ts");
      } // spray 8 → revert to the LATEST 1-error tree (B)

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
    // stateB.ts SURVIVES → the checkpoint refreshed on the lateral 1→1 move to the LATEST tree.
    expect(await Bun.file(join(dir, "stateB.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "stateA.ts")).exists()).toBe(true);
    // Checkpoint captures are bounded by EDIT events (initial arm + one per create that lands
    // near-green: stateA, stateB) — NOT by near-green cycle count. The no-op "working" turns
    // must NOT re-buffer: with dense near-green gating over ~10 turns the OLD `curr <= best`
    // rule would lock on every cycle (≥5); edit-driven caps it at ≤3.
    const locks = events.filter(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        e.message.includes("near-green checkpoint: locked")
    ).length;

    expect(locks).toBeLessThanOrEqual(3);
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
