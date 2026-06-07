import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCalls, type ILoopCtx, type ILoopState } from "../src/loop";

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
  };
}

function ctxFor(cwd: string, files: string[]): ILoopCtx {
  return {
    task: { id: "t", accept: "true", files },
    cwd,
    tsService: null,
    parse: undefined,
    report: () => undefined,
    messages: [],
  };
}

// P2: an edit/create is counted only when it actually wrote — not pre-counted
// from the tool name (which inflated churn and re-gated after no-op failures).
test("a successful in-scope create counts as one edit and re-gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "create",
          arguments: { file: "x.ts", content: "export const x = 1;\n" },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(true);
    expect(state.edits).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an out-of-scope edit is NOT counted and does not re-gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "edit",
          arguments: {
            file: "secret.ts",
            oldString: "a",
            newString: "b",
          },
        },
      ],
      ctxFor(dir, ["src/**"]), // secret.ts is out of scope
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed edit (oldString not found) is NOT counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await Bun.write(join(dir, "y.ts"), "export const y = 1;\n");

    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "edit",
          arguments: {
            file: "y.ts",
            oldString: "this text is not in the file",
            newString: "z",
          },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
