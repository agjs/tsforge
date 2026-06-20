import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runToolCalls,
  countsAsMutation,
  type ILoopCtx,
  type ILoopState,
  type ILoopEvent,
} from "../src/loop";
import { THEME_NAMES, COMPONENT_NAMES } from "../src/web-components";
import { TsService } from "../src/lsp";
import { makeFileLinter, WEB_PACKS } from "../src/detect-gate";
import { TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../src/agent";

// The interactive web session was missing the per-write lint moat (only headless
// wired `lintFile`), so eslint/architecture violations piled up at the end-of-turn
// gate instead of surfacing as each file was written. With `lintFile` wired, the
// write-guard must return the violation in the tool result for the writing turn.
test("per-write lint moat surfaces a web rule violation on the write itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-moat-"));

  try {
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
        },
        include: ["**/*.tsx", "**/*.ts"],
      })
    );

    const ctx: ILoopCtx = {
      task: { id: "t", accept: "true", files: ["**/*"] },
      cwd: dir,
      tsService: new TsService(dir),
      lintFile: makeFileLinter("react", dir, WEB_PACKS),
      parse: undefined,
      report: () => undefined,
      messages: [],
    };
    // An `as` cast trips @typescript-eslint/consistent-type-assertions (the web
    // config bans it) — type-valid so tsc is silent, leaving the eslint violation
    // to surface cleanly. The per-write moat must catch it on the write itself.
    const Bad = "export const v: string = 1 as unknown as string;\n";

    await runToolCalls(
      [{ name: "create", arguments: { file: "bad.ts", content: Bad } }],
      ctx,
      freshState()
    );

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    // The web config bans `as` via no-restricted-syntax ("No `as` type casts").
    expect(toolMsg).toContain("No `as` type casts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1 (review): add_dependency rewrites package.json even in a narrow-scoped task
// where it isn't in the editable globs. That sanctioned manifest change MUST still
// re-gate (the supply-chain meta-rules catch unpinned/git/tarball deps) — so the
// mutation predicate exempts package.json from the scope check, but nothing else.
test("countsAsMutation: package.json always counts; other out-of-scope paths don't", () => {
  expect(countsAsMutation("package.json", ["src/**"])).toBe(true);
  expect(countsAsMutation("src/a.ts", ["src/**"])).toBe(true);
  expect(countsAsMutation("secret.ts", ["src/**"])).toBe(false);
  expect(countsAsMutation("vendor/x.ts", ["src/**"])).toBe(false);
});

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
    // The moved file joins the change scope (so test-sibling et al. cover it).
    expect([...(ctx.touched ?? [])]).toContain("lib/types.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: scaffold_routes writes route stub files but reports `kind:"tool"`, so the
// old event-only accounting left `touched:false` — a turn could write stubs and
// skip the gate (which fails while a stub is unfilled). It now emits `mutated`.
test("scaffold_routes re-gates the turn despite reporting a tool event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-routes-"));

  try {
    const ctx = ctxFor(dir, ["**/*"]);
    const state = freshState();
    const touched = await runToolCalls(
      [{ name: "scaffold_routes", arguments: { routes: ["/", "/about"] } }],
      ctx,
      state
    );

    expect(touched).toBe(true);
    // The generated stubs joined the change scope but were NOT write-guarded.
    expect(ctx.touched?.size ?? 0).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: a rejected (out-of-scope) move_file must NOT re-gate — the old name-based
// branch set touched:true by tool NAME, so a rejected op could let a green gate
// claim "done" though nothing moved. Now the signal is the `mutated` event, which
// a reject never emits.
test("a rejected (out-of-scope) move_file does NOT re-gate (no false 'done')", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-reject-"));

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
    // use.ts imports types.ts and is OUT of editable scope → moving types.ts
    // would rewrite a read-only importer, so the move is rejected.
    await Bun.write(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const ctx: ILoopCtx = {
      task: { id: "t", accept: "true", files: ["types.ts", "lib/types.ts"] },
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

    expect(touched).toBe(false);
    // Nothing moved.
    expect(await Bun.file(join(dir, "types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "lib/types.ts")).exists()).toBe(false);
    expect(ctx.touched?.size ?? 0).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// WS1: structural meta-rules used to fire only at the end-of-turn gate. The
// single-file-safe subset now runs PER-WRITE, so a logic file created without a
// test gets the test-sibling nudge immediately in the tool result — not after the
// model has built more on top of it.
test("a created logic file without a test gets an immediate per-write nudge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-perwrite-"));

  try {
    const ctx = ctxFor(dir, ["**/*"]);
    const state = freshState();

    await runToolCalls(
      [
        {
          name: "create",
          arguments: {
            file: "calc.ts",
            content:
              "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
          },
        },
      ],
      ctx,
      state
    );

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    // The structural nudge rode back on THIS write (not deferred to the gate).
    expect(toolMsg).toContain("test-sibling-required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A co-located test means no nudge — the per-write check is satisfied immediately.
test("a created logic file WITH a co-located test gets no test nudge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-perwrite2-"));

  try {
    await Bun.write(
      join(dir, "calc.test.ts"),
      'import { test } from "bun:test";\ntest("x", () => {});\n'
    );

    const ctx = ctxFor(dir, ["**/*"]);
    const state = freshState();

    await runToolCalls(
      [
        {
          name: "create",
          arguments: {
            file: "calc.ts",
            content:
              "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
          },
        },
      ],
      ctx,
      state
    );

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(toolMsg).not.toContain("test-sibling-required");
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

// The MUTATING-TOOL ACCOUNTING CONTRACT, made structural: every registered tool is
// classified exactly once — read-only (plan-mode safe), mutating (must report a
// change so the gate re-runs), or special (run/yield, exempt with a reason). A NEW
// tool that lands in zero buckets fails here until someone decides which it is —
// the guard that would have caught scaffold_web silently mutating from day one.
const MUTATING_TOOLS = new Set<string>([
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
  TOOL_NAME.create,
  TOOL_NAME.renameSymbol,
  TOOL_NAME.moveFile,
  TOOL_NAME.organizeImports,
  TOOL_NAME.scaffoldUi,
  TOOL_NAME.scaffoldRoutes,
  TOOL_NAME.scaffoldWeb,
  TOOL_NAME.addDependency,
]);
// run = the model's raw shell (writes are its own, not scoped harness edits);
// yield_status = turn control, never touches the workspace.
const SPECIAL_TOOLS = new Set<string>([TOOL_NAME.run, TOOL_NAME.yieldStatus]);

test("every registered tool is classified read-only, mutating, or special", () => {
  for (const name of Object.values(TOOL_NAME)) {
    const buckets = [
      READ_ONLY_TOOL_NAMES.has(name),
      MUTATING_TOOLS.has(name),
      SPECIAL_TOOLS.has(name),
    ].filter(Boolean).length;

    expect({ name, buckets }).toEqual({ name, buckets: 1 });
  }
});

// P1 (review): scaffold_web mutates the workspace via ctx.setupWeb but emitted NO
// `mutated` event, so the loop never re-gated — a whole Vite app could be scaffolded
// and the gate never run. With setupWeb returning the written files, scaffold_web
// now reports them and the turn re-gates (and the files join the change scope).
function webCtx(
  cwd: string,
  setup: () => Promise<{ files: readonly string[]; depsInstalled: boolean }>
): ILoopCtx {
  return { ...ctxFor(cwd, ["**/*"]), setupWeb: setup };
}

test("scaffold_web re-gates the turn and joins the scaffolded files to scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-web-"));

  try {
    const written = ["src/main.tsx", "index.html"];
    const ctx = webCtx(dir, () =>
      Promise.resolve({ files: written, depsInstalled: true })
    );
    const touched = await runToolCalls(
      [{ name: "scaffold_web", arguments: { framework: "react" } }],
      ctx,
      freshState()
    );

    expect(touched).toBe(true);

    for (const f of written) {
      expect([...(ctx.touched ?? [])]).toContain(f);
    }

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(toolMsg).toContain("deps installed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold_web tells the model the truth (and still re-gates) when install failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-web-fail-"));

  try {
    const ctx = webCtx(dir, () =>
      Promise.resolve({ files: ["src/main.tsx"], depsInstalled: false })
    );
    const touched = await runToolCalls(
      [{ name: "scaffold_web", arguments: { framework: "react" } }],
      ctx,
      freshState()
    );

    expect(touched).toBe(true);

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    // Must NOT claim a clean install; must tell the model to run `bun install`.
    expect(toolMsg).not.toContain("deps installed");
    expect(toolMsg).toContain("bun install");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold_web forwards the turn's abort signal to setupWeb (cancellable install)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-web-sig-"));

  try {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const ctx: ILoopCtx = {
      ...ctxFor(dir, ["**/*"]),
      signal: controller.signal,
      setupWeb: (_fw, options) => {
        received = options?.signal;

        return Promise.resolve({
          files: ["src/main.tsx"],
          depsInstalled: true,
        });
      },
    };

    await runToolCalls(
      [{ name: "scaffold_web", arguments: { framework: "react" } }],
      ctx,
      freshState()
    );

    expect(received).toBe(controller.signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold_web that writes nothing does NOT re-gate (no false 'done')", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-web-noop-"));

  try {
    const ctx = webCtx(dir, () =>
      Promise.resolve({ files: [], depsInstalled: true })
    );
    const touched = await runToolCalls(
      [{ name: "scaffold_web", arguments: { framework: "react" } }],
      ctx,
      freshState()
    );

    expect(touched).toBe(false);
    expect(ctx.touched?.size ?? 0).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── P1/P2 contract regression tests (harness review: tools) ────────────────────

/** A report sink that records every event, plus the ctx wired to it. */
function collectingCtx(
  cwd: string,
  files: string[]
): { ctx: ILoopCtx; events: ILoopEvent[] } {
  const events: ILoopEvent[] = [];
  const ctx: ILoopCtx = {
    task: { id: "t", accept: "true", files },
    cwd,
    tsService: null,
    parse: undefined,
    report: (e) => {
      events.push(e);
    },
    messages: [],
  };

  return { ctx, events };
}

/** True when the FS enforces a chmod 555 (root bypasses perms → caller skips). */
async function permsEnforced(dir: string): Promise<boolean> {
  try {
    await Bun.write(join(dir, ".probe"), "x");
    await rm(join(dir, ".probe"), { force: true });

    return false;
  } catch {
    return true;
  }
}

// P1: a handler that THROWS (here `create` hitting an unwritable dir → EACCES) must
// be caught at the executeTool boundary and returned as a tool-error string — never
// thrown into runToolCalls. The write didn't happen, so it isn't counted.
test("a throwing create is caught (no crash), reported FAILED, and not counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await mkdir(join(dir, "ro"), { recursive: true });
    await chmod(join(dir, "ro"), 0o555);

    if (!(await permsEnforced(join(dir, "ro")))) {
      return; // running as root — perms not enforced
    }

    const { ctx } = collectingCtx(dir, ["**/*"]);
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "create",
          arguments: { file: "ro/x.ts", content: "export const x = 1;\n" },
        },
      ],
      ctx,
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
    const msg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(msg).toContain("FAILED");
    expect(await Bun.file(join(dir, "ro/x.ts")).exists()).toBe(false);
  } finally {
    await chmod(join(dir, "ro"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: scaffold_ui writes are ATOMIC — when a write fails the batch rolls back, so a
// pre-existing file is left untouched, nothing is counted, and NO `mutated` event
// fires (a half-written set must never re-gate as if it succeeded).
test("scaffold_ui rolls back on a write failure: disk unchanged, no mutated event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "src/index.css"), "MARKER");
    await chmod(join(dir, "src"), 0o555);

    if (!(await permsEnforced(join(dir, "src")))) {
      return;
    }

    const { ctx, events } = collectingCtx(dir, ["**/*"]);
    const touched = await runToolCalls(
      [
        {
          name: "scaffold_ui",
          arguments: {
            theme: THEME_NAMES[0],
            components: [COMPONENT_NAMES[0]],
          },
        },
      ],
      ctx,
      freshState()
    );

    expect(touched).toBe(false);
    expect(events.some((e) => e.mutated !== undefined)).toBe(false);
    expect(await Bun.file(join(dir, "src/index.css")).text()).toBe("MARKER");
  } finally {
    await chmod(join(dir, "src"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// P2: scaffold_ui with nothing in the editable scope must REJECT honestly — never
// emit the success copy that tells the model to import primitives never written.
test("scaffold_ui out of scope rejects without the import advice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const { ctx } = collectingCtx(dir, ["src/lib/**"]);
    const touched = await runToolCalls(
      [
        {
          name: "scaffold_ui",
          arguments: {
            theme: THEME_NAMES[0],
            components: [COMPONENT_NAMES[0]],
          },
        },
      ],
      ctx,
      freshState()
    );

    expect(touched).toBe(false);
    const msg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(msg).not.toContain("Import these from @/components/ui");
    expect(msg.toLowerCase()).toContain("scope");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// add_dependency validates names offline (no network) — an invalid spec rejects and
// nothing is written/counted.
test("add_dependency rejects an invalid package spec and does not mutate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0" })
    );

    const { ctx } = collectingCtx(dir, ["**/*"]);
    const state = freshState();
    const touched = await runToolCalls(
      [{ name: "add_dependency", arguments: { packages: "../evil" } }],
      ctx,
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
