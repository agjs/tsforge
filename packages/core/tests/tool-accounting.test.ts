import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCalls, type ILoopCtx, type ILoopState } from "../src/loop";
import { TsService } from "../src/lsp";

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
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

// P1: move_file relocates a file AND rewrites every importer, but reports a
// `tool` event (not edit/create) so `wrote.value` stays false. It must still be
// counted as a semantic write so the gate re-runs — otherwise a move could end
// the turn as "responded" with the relocation/import-rewrites never gated.
test("a move_file re-gates even though it is not an edit/create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-move-"));

  try {
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      })
    );
    await Bun.write(
      join(dir, "types.ts"),
      "export interface IThing {\n  value: number;\n}\n"
    );
    await Bun.write(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const ctx: ILoopCtx = {
      task: { id: "t", accept: "true", files: ["**/*"] },
      cwd: dir,
      tsService: new TsService(dir),
      parse: undefined,
      report: () => undefined,
      messages: [],
    };
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "move_file",
          arguments: { from: "types.ts", to: "lib/types.ts" },
        },
      ],
      ctx,
      state
    );

    // The move actually happened...
    expect(await Bun.file(join(dir, "lib/types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "use.ts")).text()).toContain("lib/types");
    // ...and it re-gates (this was `false` before the fix). Semantic writes
    // don't feed state.edits, so only the re-gate signal changes.
    expect(touched).toBe(true);
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
