import { test, expect, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doScript,
  generateToolStubs,
  type ExecuteFn,
} from "../src/loop/tools/script-tool";
import { executeTool } from "../src/loop/tools/execute-tool";
import { READ_ONLY_TOOL_NAMES, SCRIPT_EXPOSABLE_TOOLS } from "../src/agent";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { ILoopEvent } from "../src/loop/loop.types";

// The script tool creates its temp dir inside ctx.cwd (so workspace module
// resolution works) — point the default cwd at an isolated temp dir, never the
// repo, so no `.tsforge-script-*` artifacts land here.
const TMP_CWD = mkdtempSync(join(tmpdir(), "tsforge-script-cwd-"));

afterAll(async () => {
  await rm(TMP_CWD, { recursive: true, force: true });
});

interface ICtxOpts {
  cwd?: string;
  files?: string[];
  readOnly?: boolean;
}

function makeCtx(opts: ICtxOpts, events: ILoopEvent[]): IToolContext {
  return {
    cwd: opts.cwd ?? TMP_CWD,
    files: opts.files ?? [],
    task: "t",
    report: (e) => events.push(e),
    ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }),
  };
}

/** A fake tool dispatcher: records each call and returns a canned string. */
function recordingExecute(calls: string[]): ExecuteFn {
  return async (call) => {
    calls.push(call.name);

    return `R:${call.name}`;
  };
}

test("the script-exposable subset is the safe/useful tools, never script itself", () => {
  // Useful read + mutation + research tools are reachable from a script…
  for (const name of [
    "read",
    "run",
    "search",
    "edit",
    "create",
    "web_search",
  ]) {
    expect(SCRIPT_EXPOSABLE_TOOLS.has(name)).toBe(true);
  }

  // …but the heavy/interactive + recursion-prone ones are NOT.
  for (const name of [
    "script",
    "scaffold_web",
    "add_dependency",
    "yield_status",
  ]) {
    expect(SCRIPT_EXPOSABLE_TOOLS.has(name)).toBe(false);
  }

  // Plan-mode (read-only) set stays mutation-free and excludes script.
  expect(READ_ONLY_TOOL_NAMES.has("read")).toBe(true);
  expect(READ_ONLY_TOOL_NAMES.has("web_fetch")).toBe(true);
  expect(READ_ONLY_TOOL_NAMES.has("edit")).toBe(false);
  expect(READ_ONLY_TOOL_NAMES.has("run")).toBe(false);
  expect(READ_ONLY_TOOL_NAMES.has("script")).toBe(false);
});

test("generateToolStubs emits one async fn per tool plus the __call helper", () => {
  const src = generateToolStubs(["read", "web_search"]);

  expect(src).toContain("export async function read(args = {})");
  expect(src).toContain("export async function web_search(args = {})");
  expect(src).toContain("async function __call(tool, args)");
  expect(src).toContain("x-tsforge-token");
  // No stub for `script` is ever generated (no recursion entry point).
  expect(src).not.toContain("function script(");
});

test("a script collapses N tool calls into ONE turn and returns only stdout", async () => {
  const calls: string[] = [];
  const events: ILoopEvent[] = [];
  const code = [
    'import { read } from "./tsforge-tools";',
    'const a = await read({ file: "x" });',
    'const b = await read({ file: "y" });',
    'console.log("GOT", a, b);',
  ].join("\n");

  const out = await doScript({ code }, makeCtx({}, events), {
    execute: recordingExecute(calls),
  });

  expect(calls).toEqual(["read", "read"]);
  expect(out).toContain("2 tool calls");
  expect(out).toContain("GOT R:read R:read");
  // Each stub call is surfaced on the ledger for observability.
  expect(events.filter((e) => e.message === "↳ script:read")).toHaveLength(2);
});

test("a script resolves the workspace's node_modules (temp dir lives in cwd)", async () => {
  // The temp dir is created INSIDE ctx.cwd so module resolution walks up to the
  // project's node_modules — a script can import a workspace dep, not just stubs.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-nm-"));

  try {
    await mkdir(join(dir, "node_modules", "leftpad"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "leftpad", "package.json"),
      JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" })
    );
    await writeFile(
      join(dir, "node_modules", "leftpad", "index.js"),
      'module.exports = { tag: () => "LEFTPAD_OK" };\n'
    );

    const events: ILoopEvent[] = [];
    const code = ['import { tag } from "leftpad";', "console.log(tag());"].join(
      "\n"
    );

    const out = await doScript({ code }, makeCtx({ cwd: dir }, events), {
      execute: executeTool,
    });

    expect(out).toContain("LEFTPAD_OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an in-scope create through the stub lands through executeTool + reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-"));

  try {
    const events: ILoopEvent[] = [];
    const code = [
      'import { create } from "./tsforge-tools";',
      'const r = await create({ file: "out.ts", content: "export const x = 1;\\n" });',
      "console.log(r);",
    ].join("\n");

    const out = await doScript(
      { code },
      makeCtx({ cwd: dir, files: ["out.ts"] }, events),
      {
        execute: executeTool,
      }
    );

    expect(out).toContain("created out.ts");
    expect(await Bun.file(join(dir, "out.ts")).exists()).toBe(true);
    expect(events.some((e) => e.kind === "create" && e.file === "out.ts")).toBe(
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an out-of-scope create through the stub is rejected (scope inherited)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-"));

  try {
    const events: ILoopEvent[] = [];
    const code = [
      'import { create } from "./tsforge-tools";',
      'const r = await create({ file: "other.ts", content: "export const y = 2;\\n" });',
      "console.log(r);",
    ].join("\n");

    const out = await doScript(
      { code },
      makeCtx({ cwd: dir, files: ["allowed.ts"] }, events),
      { execute: executeTool }
    );

    expect(out).toContain("REJECTED");
    expect(await Bun.file(join(dir, "other.ts")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plan mode rejects `script` at dispatch — no subprocess runs", async () => {
  const calls: string[] = [];
  const events: ILoopEvent[] = [];

  const out = await executeTool(
    { name: "script", arguments: { code: 'console.log("SHOULD_NOT_RUN");' } },
    makeCtx({ readOnly: true }, events)
  );

  expect(out).toContain("plan mode");
  expect(out).not.toContain("SHOULD_NOT_RUN");
  expect(calls).toHaveLength(0);
});

test("the per-script tool-call cap is enforced", async () => {
  const prev = process.env.TSFORGE_SCRIPT_MAX_CALLS;

  process.env.TSFORGE_SCRIPT_MAX_CALLS = "2";

  try {
    const events: ILoopEvent[] = [];
    const code = [
      'import { read } from "./tsforge-tools";',
      "await read({});",
      "await read({});",
      "try {",
      "  await read({});",
      "} catch (e) {",
      '  console.log("CAUGHT", e.message);',
      "}",
    ].join("\n");

    const out = await doScript({ code }, makeCtx({}, events), {
      execute: recordingExecute([]),
    });

    expect(out).toContain("CAUGHT");
    expect(out).toContain("tool-call limit (2) exceeded");
  } finally {
    if (prev === undefined) {
      delete process.env.TSFORGE_SCRIPT_MAX_CALLS;
    } else {
      process.env.TSFORGE_SCRIPT_MAX_CALLS = prev;
    }
  }
});

test("a runaway script is killed at the wall-clock timeout", async () => {
  const events: ILoopEvent[] = [];
  const out = await doScript(
    { code: "while (true) {}", timeoutMs: 400 },
    makeCtx({}, events),
    { execute: recordingExecute([]) }
  );

  expect(out).toContain("killed: exceeded");
  expect(out).not.toContain("script exit 0");
});

test("the RPC server rejects a request with a wrong token", async () => {
  const events: ILoopEvent[] = [];
  const code = [
    "const res = await fetch(process.env.TSFORGE_RPC_URL, {",
    '  method: "POST",',
    '  headers: { "content-type": "application/json", "x-tsforge-token": "WRONG" },',
    '  body: JSON.stringify({ tool: "read", args: {} }),',
    "});",
    'console.log("STATUS", res.status);',
  ].join("\n");

  const calls: string[] = [];
  const out = await doScript({ code }, makeCtx({}, events), {
    execute: recordingExecute(calls),
  });

  expect(out).toContain("STATUS 403");
  expect(calls).toHaveLength(0);
});

test("the RPC server refuses `script` (no recursion) and non-exposable tools", async () => {
  const events: ILoopEvent[] = [];
  const code = [
    "async function call(tool) {",
    "  const res = await fetch(process.env.TSFORGE_RPC_URL, {",
    '    method: "POST",',
    '    headers: { "content-type": "application/json", "x-tsforge-token": process.env.TSFORGE_RPC_TOKEN },',
    "    body: JSON.stringify({ tool, args: {} }),",
    "  });",
    "  return (await res.json()).error;",
    "}",
    'console.log("SCRIPT:", await call("script"));',
    'console.log("SCAFFOLD:", await call("scaffold_web"));',
  ].join("\n");

  const calls: string[] = [];
  const out = await doScript({ code }, makeCtx({}, events), {
    execute: recordingExecute(calls),
  });

  expect(out).toContain("SCRIPT: tool `script` is not callable from a script");
  expect(out).toContain(
    "SCAFFOLD: tool `scaffold_web` is not callable from a script"
  );
  expect(calls).toHaveLength(0);
});

test("concurrent stub calls are serialized (no interleaved dispatch)", async () => {
  const order: string[] = [];
  let seq = 0;

  const execute: ExecuteFn = async () => {
    const id = (seq += 1);

    order.push(`start:${String(id)}`);
    await new Promise((r) => setTimeout(r, 15));
    order.push(`end:${String(id)}`);

    return `r${String(id)}`;
  };

  const events: ILoopEvent[] = [];
  const code = [
    'import { read } from "./tsforge-tools";',
    "await Promise.all([read({}), read({})]);",
    'console.log("done");',
  ].join("\n");

  await doScript({ code }, makeCtx({}, events), { execute });

  expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
});

test("empty `code` is rejected without spawning anything", async () => {
  const calls: string[] = [];
  const events: ILoopEvent[] = [];
  const out = await doScript({ code: "   " }, makeCtx({}, events), {
    execute: recordingExecute(calls),
  });

  expect(out).toContain("must be a non-empty");
  expect(calls).toHaveLength(0);
});
