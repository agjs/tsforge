import { test, expect, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doScript,
  generateToolStubs,
  SCRIPT_POSITIONAL_ARG,
  type ExecuteFn,
} from "../src/loop/tools/script-tool";
import { executeTool } from "../src/loop/tools/execute-tool";
import {
  READ_ONLY_TOOL_NAMES,
  READ_TOOL,
  RUN_TOOL,
  SEARCH_TOOL,
  SCRIPT_EXPOSABLE_TOOLS,
} from "../src/agent";
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

test("single-string-arg tools accept a positional string; multi-arg tools don't", () => {
  const src = generateToolStubs(["read", "run", "search", "create", "edit"]);

  // read/run/search wrap a bare string into their named arg…
  expect(src).toContain('typeof args === "string" ? { "file": args }');
  expect(src).toContain('typeof args === "string" ? { "command": args }');
  expect(src).toContain('typeof args === "string" ? { "pattern": args }');
  // …but create/edit (multi required arg) stay object-only — no string coercion.
  expect(src).toContain("export async function create(args = {}) {");
  expect(src).not.toContain('"content": args');
  expect(src).not.toContain('"oldString": args');
});

test("SCRIPT_POSITIONAL_ARG maps only sole-required-string-param tools (drift guard)", () => {
  // Each mapped param must be the EXACT single required arg of the real schema,
  // so the map can't silently drift from the tool definitions it shadows.
  const required = {
    read: READ_TOOL.function.parameters.required,
    run: RUN_TOOL.function.parameters.required,
    search: SEARCH_TOOL.function.parameters.required,
  };

  for (const [tool, param] of Object.entries(SCRIPT_POSITIONAL_ARG)) {
    expect(required[tool as keyof typeof required]).toEqual([param]);
  }

  // Every mapped tool is actually script-exposable.
  for (const tool of Object.keys(SCRIPT_POSITIONAL_ARG)) {
    expect(SCRIPT_EXPOSABLE_TOOLS.has(tool)).toBe(true);
  }
});

test("a positional read('file') returns content, not a silent rejection", async () => {
  // Regression: the natural `read("a.ts")` idiom used to be coerced to `{}` by
  // the RPC server, the tool rejected for a missing `file`, and the rejection
  // TEXT came back as the read's RESULT (a script then treats it as content).
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-pos-"));

  try {
    await writeFile(
      join(dir, "svc1.ts"),
      "// tier: gold\nexport const x = 1;\n"
    );

    const events: ILoopEvent[] = [];
    const code = [
      'import { read } from "./tsforge-tools";',
      'const content = await read("svc1.ts");',
      "console.log(content);",
    ].join("\n");

    const out = await doScript(
      { code },
      makeCtx({ cwd: dir, files: ["svc1.ts"] }, events),
      { execute: executeTool }
    );

    expect(out).toContain("tier: gold"); // real file content came back
    expect(out).not.toContain("malformed args"); // NOT the rejection string
    expect(events.some((e) => e.message === "tool_input_rejected:read")).toBe(
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool call rejected inside a script THROWS with the reason, not silent data", async () => {
  // Regression: a rejected in-script call used to return its rejection TEXT as a
  // normal value, so the script carried on treating the reason as data (observed:
  // a migrate run's 8 edits were all `tool_input_rejected:edit`, the script printed
  // "Updated …" and exited 0, and the model never saw they failed). Now it throws.
  const events: ILoopEvent[] = [];
  const code = [
    'import { read } from "./tsforge-tools";',
    "try {",
    "  await read({});", // no `file` → tool_input_rejected:read
    '  console.log("NO_THROW");',
    "} catch (e) {",
    '  console.log("THREW", e.message);',
    "}",
  ].join("\n");

  const out = await doScript({ code }, makeCtx({}, events), {
    execute: executeTool,
  });

  expect(out).toContain("THREW");
  expect(out).toContain("read rejected:"); // surfaced with the real reason
  expect(out).not.toContain("NO_THROW"); // the call did NOT silently succeed
  expect(events.some((e) => e.message === "tool_input_rejected:read")).toBe(
    true
  );
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

test("a child backgrounded inside a script does not survive the timeout kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-"));

  try {
    const marker = join(dir, "leaked-marker");
    // The script backgrounds a grandchild that would touch a marker AFTER the
    // timeout fires. Killing only the `bun` process (the old bug) leaves the
    // grandchild alive to touch it; a process-GROUP kill takes it down too.
    const code = [
      `Bun.spawn(["sh", "-c", ${JSON.stringify(`sleep 1.5 && touch ${marker}`)}]);`,
      "while (true) {}",
    ].join("\n");
    const events: ILoopEvent[] = [];

    const out = await doScript(
      { code, timeoutMs: 400 },
      makeCtx({ cwd: dir }, events),
      { execute: recordingExecute([]) }
    );

    expect(out).toContain("killed: exceeded");

    // Wait past when the leaked child WOULD have touched the marker.
    await new Promise((r) => setTimeout(r, 2000));

    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("the output drain is bounded when a backgrounded child holds the pipe open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-script-"));

  try {
    // `sh` backgrounds `sleep 5` (which inherits — and holds open — the script's
    // stdout pipe) then exits immediately, so `bun` exits fast while the orphan
    // keeps the pipe open. An unbounded drain (`Response(stdout).text()`) would
    // block the whole 5s waiting for EOF; the shared runner bounds it.
    const code = [
      `Bun.spawnSync(["sh", "-c", "sleep 5 &"], { stdout: "inherit" });`,
      'console.log("SCRIPT_DONE");',
    ].join("\n");
    const events: ILoopEvent[] = [];

    const started = Date.now();
    const out = await doScript(
      { code, timeoutMs: 30_000 },
      makeCtx({ cwd: dir }, events),
      { execute: recordingExecute([]) }
    );
    const elapsed = Date.now() - started;

    expect(out).toContain("SCRIPT_DONE");
    expect(elapsed).toBeLessThan(3000); // bounded ~500ms, not the child's 5s
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

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

test("captured script output is PLAIN — no ANSI color on logged values", async () => {
  // The script's stdout is captured (parsed by the loop, matched in tests), never
  // shown live — so Bun's console.log colorization (a number `403` →
  // `\x1b[33m403\x1b[0m` under a TTY) is corruption that made captured output
  // differ CI-vs-local. runScript sets NO_COLOR/FORCE_COLOR so output is stable;
  // this locks that in — a regression re-enabling color would fail here.
  const events: ILoopEvent[] = [];
  const code = 'console.log("VAL", 403, true, { a: 1 });';
  const out = await doScript({ code }, makeCtx({}, events), {
    execute: recordingExecute([]),
  });

  // No ANSI escape sequence anywhere in the captured output.
  expect(out).not.toContain("[");
  // And the plain values survive verbatim (proves it's off, not stripped-after).
  expect(out).toContain("VAL 403 true");
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

test("captured script output is ANSI-free even when the parent env forces color", async () => {
  // The subprocess stdout is CAPTURED (parsed by the loop, matched in tests),
  // never shown live — so Bun colorizing a console.log'd value (a numeric 403 →
  // \x1b[33m403\x1b[0m under a color-enabled parent) is corruption that made
  // captured output differ between CI (plain) and a local TTY (colored). The tool
  // sets NO_COLOR/FORCE_COLOR=0 in the child env; the captured text must be plain.
  const events: ILoopEvent[] = [];
  const savedForce = process.env.FORCE_COLOR;

  process.env.FORCE_COLOR = "1"; // simulate a color-enabled parent (local TTY)

  try {
    const out = await doScript(
      { code: "console.log(403);" },
      makeCtx({}, events),
      { execute: recordingExecute([]) }
    );

    expect(out).not.toMatch(new RegExp(String.fromCharCode(27)));
    expect(out).toContain("403");
  } finally {
    if (savedForce === undefined) {
      Reflect.deleteProperty(process.env, "FORCE_COLOR");
    } else {
      process.env.FORCE_COLOR = savedForce;
    }
  }
});
