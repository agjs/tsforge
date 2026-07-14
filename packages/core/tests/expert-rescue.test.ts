import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryExpertRescue, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import type { IErrorItem } from "../src/validate";
import type { ExpertAsk } from "../src/loop/expert-handoff";

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
    steerLevel: 4,
  };
}

function makeCtx(events: ILoopEvent[], cwd: string): ILoopCtx {
  return {
    task: { id: "t", intent: "test", accept: "true", files: [], context: [] },
    cwd,
    tsService: null,
    report: (event) => {
      events.push(event);
    },
    messages: [],
    tool: {},
    gate: { parse: undefined },
  };
}

const fileErr = (file: string): IErrorItem => ({
  key: `${file}:1:no-restricted-syntax`,
  file,
  rule: "no-restricted-syntax",
  message: "L1: No `as` type casts",
});

const toolMsgs = (events: ILoopEvent[]): string[] =>
  events.filter((e) => e.kind === "tool").map((e) => e.message);

describe("tryExpertRescue", () => {
  test("HAPPY PATH: expert returns a fix → file overwritten, run continues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-rescue-"));

    try {
      await Bun.write(join(dir, "x.ts"), "export const s = v as any;\n");
      const events: ILoopEvent[] = [];
      const ctx = makeCtx(events, dir);
      const state = freshState();

      // Set up state as if samePersist has fired (error age >= 5)
      const errKey = `x.ts:1:no-restricted-syntax`;

      state.errorAge.set(errKey, 5);
      state.triedLeversByBlock = new Map();

      const ask: ExpertAsk = async () =>
        "```ts\nexport const s = String(v);\n```";

      const rescued = await tryExpertRescue(
        ctx,
        state,
        [fileErr("x.ts")],
        async () => ask
      );

      expect(rescued).toBe(true);
      // The stuck file was repaired by the expert.
      expect(await Bun.file(join(dir, "x.ts")).text()).toBe(
        "export const s = String(v);\n"
      );
      // Guards + steer level reset so the primary model gets a fresh run.
      // R4 should be recorded for the block (novelty gate).
      expect(state.steerLevel).toBe(0);
      // The model was told to verify + continue.
      expect(ctx.messages.at(-1)?.content).toContain("expert engineer");
      // The handoff was VISIBLE in the log (not silent).
      expect(toolMsgs(events).some((m) => m.includes("expert handoff"))).toBe(
        true
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no expert configured → returns false AND logs why (never silent)", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events, "/tmp");
    const state = freshState();

    const rescued = await tryExpertRescue(
      ctx,
      state,
      [fileErr("x.ts")],
      async () => null
    );

    expect(rescued).toBe(false);
    // The exact bug that hid for a whole run: this MUST be logged now.
    expect(
      toolMsgs(events).some(
        (m) => m.includes("skipped") && m.includes("expert")
      )
    ).toBe(true);
  });

  test("unchanged fingerprint → expert fires at most once (novelty gate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-rescue-novelty-"));

    try {
      await Bun.write(join(dir, "x.ts"), "export const s = v as any;\n");
      const events: ILoopEvent[] = [];
      const ctx = makeCtx(events, dir);
      const state = freshState();

      const ask: ExpertAsk = async () =>
        "```ts\nexport const s = String(v);\n```";

      // Initialize triedLeversByBlock and set up state as if samePersist has fired
      state.triedLeversByBlock = new Map();
      const errKey = `x.ts:1:no-restricted-syntax`;

      state.errorAge.set(errKey, 5);

      // First call: expert should fire
      const rescued1 = await tryExpertRescue(
        ctx,
        state,
        [fileErr("x.ts")],
        async () => ask
      );

      expect(rescued1).toBe(true);

      // After successful fix, R4 should be recorded for the block (the samePersist key)
      const block1 = errKey;

      expect(state.triedLeversByBlock.get(block1)?.has("R4")).toBe(true);

      // Revert the file to trigger another stall
      await Bun.write(join(dir, "x.ts"), "export const s = v as any;\n");

      // Reset state for second call but keep triedLeversByBlock
      state.steerLevel = 4;
      state.errorAge.set(errKey, 10); // error persists

      // Second call on same block: expert should skip because R4 already tried
      const rescued2 = await tryExpertRescue(
        ctx,
        state,
        [fileErr("x.ts")],
        async () => ask
      );

      expect(rescued2).toBe(false);

      // Message should indicate "already tried for this block"
      expect(
        toolMsgs(events).some((m) => m.includes("already tried for this block"))
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("changed fingerprint after expert fix → expert may fire again (novelty)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expert-rescue-new-block-"));

    try {
      await Bun.write(join(dir, "x.ts"), "export const s = v as any;\n");
      await Bun.write(join(dir, "y.ts"), "export const t = w as any;\n");
      const events: ILoopEvent[] = [];
      const ctx = makeCtx(events, dir);
      const state = freshState();

      const ask: ExpertAsk = async () =>
        "```ts\nexport const s = String(v);\n```";

      state.triedLeversByBlock = new Map();
      const errKey1 = `x.ts:1:no-restricted-syntax`;

      state.errorAge.set(errKey1, 5);

      // First call: expert fixes x.ts
      const rescued1 = await tryExpertRescue(
        ctx,
        state,
        [fileErr("x.ts")],
        async () => ask
      );

      expect(rescued1).toBe(true);
      expect(state.triedLeversByBlock.get(errKey1)?.has("R4")).toBe(true);

      // Simulate progress: x.ts is fixed, now y.ts is the problem (new block)
      state.steerLevel = 4;
      const errKey2 = `y.ts:1:no-restricted-syntax`;

      // Clear the old error age, set a new one for y.ts (different block)
      state.errorAge.delete(errKey1);
      state.errorAge.set(errKey2, 5);

      // Second call on a NEW block: expert should fire again (not recorded for this block)
      const ask2: ExpertAsk = async () =>
        "```ts\nexport const t = String(w);\n```";
      const rescued2 = await tryExpertRescue(
        ctx,
        state,
        [fileErr("y.ts")],
        async () => ask2
      );

      expect(rescued2).toBe(true);

      // R4 should be recorded for the new block
      expect(state.triedLeversByBlock.get(errKey2)?.has("R4")).toBe(true);

      // Original block's record should still exist
      expect(state.triedLeversByBlock.get(errKey1)?.has("R4")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no file-scoped error → skips with a visible reason", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events, "/tmp");
    const state = freshState();

    // Set up state as if samePersist has fired
    state.errorAge.set("k", 5);
    state.triedLeversByBlock = new Map();
    const ask: ExpertAsk = async () => "```ts\nx\n```";

    const rescued = await tryExpertRescue(
      ctx,
      state,
      [{ key: "k", rule: "r", message: "no file here" }],
      async () => ask
    );

    expect(rescued).toBe(false);
    expect(
      toolMsgs(events).some((m) => m.includes("no file could be resolved"))
    ).toBe(true);
  });
});
