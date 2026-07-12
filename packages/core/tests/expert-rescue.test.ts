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
      // Guards + steer level reset so the primary model gets a fresh run; use counted.
      expect(state.expertUses).toBe(1);
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

  test("cap reached → skips with a visible reason", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events, "/tmp");
    const state = { ...freshState(), expertUses: 2 };
    const ask: ExpertAsk = async () => "```ts\nx\n```";

    const rescued = await tryExpertRescue(
      ctx,
      state,
      [fileErr("x.ts")],
      async () => ask
    );

    expect(rescued).toBe(false);
    expect(toolMsgs(events).some((m) => m.includes("already used"))).toBe(true);
  });

  test("no file-scoped error → skips with a visible reason", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events, "/tmp");
    const state = freshState();
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
