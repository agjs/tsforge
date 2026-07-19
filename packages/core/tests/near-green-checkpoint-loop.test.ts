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
  settleGate,
} from "../src/loop/turn";
import type { IValidateResult } from "../src/validate";
import { MAX_NEAR_GREEN_ROLLBACKS } from "../src/loop/near-green-checkpoint";

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

test("#61: settleGate does NOT checkpoint a HOLLOW near-green state (all-completion-class errors) and clears any prior one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));

  try {
    await Bun.write(join(dir, "feature.ts"), "export const GOOD = 1;\n");

    // The gate is near-green with ONE remaining error that clears only by ADDING code (the
    // feature declared i18n keys it hasn't wired yet). settleGate must NOT lock this hollow
    // state — else the model's demanded completion edit (which spikes the count) gets reverted.
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
      tool: { touched: new Set(["feature.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => ({
            passed: false,
            errors: [
              {
                key: "i18n:supplier.createSuccess",
                rule: "i18n-locale-keys-used",
                message: "Locale key defined but never referenced",
              },
            ],
            output: "",
          }),
        },
      },
    };

    // Seed a stale checkpoint from an earlier compile-clean cycle — the guard must CLEAR it,
    // so a later spray can't be reverted to it either.
    const stale = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "old", message: "earlier compile error" },
    ]);
    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 1,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: 1,
      edits: 5,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      conventionsEnabled: false,
      nearGreenCheckpoint: stale,
      nearGreenBest: 1,
      nearGreenRollbacks: 0,
    };

    await settleGate(ctx, state, 10);

    // The hollow state was NOT protected: the checkpoint is cleared (no revert target), so
    // the model's next completion edit proceeds forward instead of being reverted to hollow.
    expect(state.nearGreenCheckpoint).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("#61: during the completion phase, a mixed-error SPIKE is NOT rolled back (banner+rollback stand down through the spike)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));

  try {
    await Bun.write(join(dir, "feature.ts"), "export const GOOD = 1;\n");

    // The model is mid-add: it entered the completion phase last cycle, and this gate shows a
    // MIXED spike (the shrinking i18n completion error + new compile errors from the half-written
    // UI) well past the rollback threshold. A per-cycle all-completion check would be FALSE here
    // and roll back; the persistent completionPhase flag must keep WS-B (and the undo banner) off.
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
      tool: { touched: new Set(["feature.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => ({
            passed: false,
            errors: [
              {
                key: "i18n:x",
                rule: "i18n-locale-keys-used",
                message: "unused key",
              },
              { key: "c1", rule: "no-unsafe-argument", message: "unsafe" },
              { key: "c2", rule: "no-unsafe-argument", message: "unsafe" },
              { key: "c3", rule: "no-unsafe-argument", message: "unsafe" },
              { key: "c4", rule: "no-unsafe-argument", message: "unsafe" },
              { key: "c5", rule: "no-unsafe-argument", message: "unsafe" },
            ],
            output: "",
          }),
        },
      },
    };
    const cp = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "i18n:x", rule: "i18n-locale-keys-used", message: "unused key" },
    ]);
    const state: ILoopState = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: 1,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: 1,
      edits: 5,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      conventionsEnabled: false,
      completionPhase: true,
      nearGreenCheckpoint: cp,
      nearGreenBest: 1,
      nearGreenRollbacks: 0,
    };

    await settleGate(ctx, state, 10);

    // 6 errors is > checkpoint(1) + M(3), so WITHOUT the phase flag WS-B would revert. It did NOT:
    // no rollback was counted, and the phase persisted (a completion error still remains).
    expect(state.nearGreenRollbacks).toBe(0);
    expect(state.completionPhase).toBe(true);
    // feature.ts was NOT reverted (no rollback restored the checkpoint snapshot).
    expect(await Bun.file(join(dir, "feature.ts")).text()).toContain("GOOD");
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

    const checkpoint = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "e0", message: "one error" },
    ]);

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

test("rollbackNearGreen TOMBSTONES a lockfile the spray CREATED (none existed at checkpoint)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-nearg-"));

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "src", "feature.ts"), "export const GOOD = 1;\n");
    // At the near-green low: package.json exists, but NO lockfile yet.
    const pkgOrig = '{"name":"app","dependencies":{}}\n';

    await Bun.write(join(dir, "package.json"), pkgOrig);

    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        files: ["src/**"], // narrow scope: dep files handled only via depFiles
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

    const checkpoint = await captureNearGreenCheckpoint(ctx, 1, [
      { key: "e0", message: "one error" },
    ]);

    // A dependency spray installs a package → add_dependency mutates package.json AND CREATES a
    // lockfile that did NOT exist at the checkpoint.
    await Bun.write(
      join(dir, "package.json"),
      '{"name":"app","dependencies":{"left-pad":"1.0.0"}}\n'
    );
    await Bun.write(join(dir, "bun.lock"), "sprayed lockfile\n");

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

    // package.json reverted to the checkpoint bytes …
    expect(await Bun.file(join(dir, "package.json")).text()).toBe(pkgOrig);
    // … and the spray-CREATED lockfile is TOMBSTONED (not left on disk to keep the tree sprayed).
    expect(await Bun.file(join(dir, "bun.lock")).exists()).toBe(false);
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
