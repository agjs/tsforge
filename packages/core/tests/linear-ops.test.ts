import { test, expect, afterEach } from "bun:test";
import {
  doLinearRead,
  doLinearWrite,
  doLinearStart,
  resolveLinearCapability,
  type ILinearDeps,
} from "../src/loop/tools/linear-ops";
import {
  lintHumanText,
  suppressCuratedSchemas,
  type IIntegrationRegistry,
} from "../src/loop/tools/integration-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (linear = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  linear,
});

/** A fake Linear MCP registry: routes `mcp__linear__<short>` to canned JSON, and
 *  records every call. Only the short names in `tools` are "exposed". */
function fakeRegistry(tools: Record<string, string>): {
  reg: IIntegrationRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const reg: IIntegrationRegistry = {
    has: (name) => Object.keys(tools).some((s) => name === `mcp__linear__${s}`),
    callTool: async (name, args) => {
      calls.push({ name, args });
      const short = name.replace("mcp__linear__", "");

      return tools[short] ?? "unknown MCP tool";
    },
  };

  return { reg, calls };
}

const deps = (
  reg: IIntegrationRegistry,
  run?: ILinearDeps["run"]
): ILinearDeps => ({
  registry: reg,
  run:
    run ??
    (async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
});

afterEach(() => {
  delete process.env.TSFORGE_LINEAR_RAW;
  delete process.env.TSFORGE_NO_LINEAR;
});

test("read issue summarizes the card and surfaces the Linear branch name", async () => {
  const { reg, calls } = fakeRegistry({
    get_issue: JSON.stringify({
      identifier: "ENG-123",
      title: "Checkout is slow",
      state: "In Progress",
      branchName: "alex/eng-123-checkout-is-slow",
      url: "https://linear.app/x/issue/ENG-123",
      description: "Users wait too long at checkout.",
    }),
  });

  const out = await doLinearRead(
    { op: "issue", id: "ENG-123" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("ENG-123 Checkout is slow");
  expect(out).toContain("branch: alex/eng-123-checkout-is-slow");
  expect(out).toContain("Users wait too long");
  // called get_issue with the identifier
  expect(calls[0]?.args.id).toBe("ENG-123");
});

test("read tolerates a Linear MCP that uses a different create tool name", async () => {
  // Only `save_issue` exposed (claude.ai naming) — create must still resolve it.
  const { reg, calls } = fakeRegistry({
    save_issue: JSON.stringify({ identifier: "ENG-9", branchName: "x/eng-9" }),
  });

  const out = await doLinearWrite(
    { op: "create", title: "Add a retry to the flaky upload" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("created ENG-9");
  expect(out).toContain("x/eng-9");
  expect(calls[0]?.name).toBe("mcp__linear__save_issue");
});

test("search lists matching issues compactly", async () => {
  const { reg } = fakeRegistry({
    list_issues: JSON.stringify([
      { identifier: "ENG-1", title: "First", state: "Todo" },
      { identifier: "ENG-2", title: "Second", state: "Done" },
    ]),
  });

  const out = await doLinearRead(
    { op: "search", query: "checkout" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("ENG-1 First [Todo]");
  expect(out).toContain("ENG-2 Second [Done]");
});

test("linear_start reads the card and checks out its branch", async () => {
  const { reg } = fakeRegistry({
    get_issue: JSON.stringify({
      identifier: "ENG-5",
      title: "Fix the thing",
      branchName: "alex/eng-5-fix-the-thing",
    }),
  });
  const ran: string[][] = [];

  const run: ILinearDeps["run"] = async (_cwd, argv) => {
    ran.push(argv);

    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };

  const out = await doLinearStart({ id: "ENG-5" }, ctx(), deps(reg, run));

  expect(out).toContain("on branch alex/eng-5-fix-the-thing for ENG-5");
  expect(ran[0]).toEqual(["git", "switch", "alex/eng-5-fix-the-thing"]);
});

test("linear_start creates the branch when switch fails (branch absent)", async () => {
  const { reg } = fakeRegistry({
    get_issue: JSON.stringify({ identifier: "ENG-6", branchName: "b/eng-6" }),
  });
  const ran: string[][] = [];

  const run: ILinearDeps["run"] = async (_cwd, argv) => {
    ran.push(argv);
    // first `switch` fails, then `switch -c` succeeds
    const failing = argv.length === 3 && argv[1] === "switch";

    return {
      stdout: "",
      stderr: failing ? "no such branch" : "",
      exitCode: failing ? 1 : 0,
      timedOut: false,
    };
  };

  await doLinearStart({ id: "ENG-6" }, ctx(), deps(reg, run));

  expect(ran[0]).toEqual(["git", "switch", "b/eng-6"]);
  expect(ran[1]).toEqual(["git", "switch", "-c", "b/eng-6"]);
});

test("write and start fail closed when the linear capability is off", async () => {
  const { reg, calls } = fakeRegistry({
    save_issue: "{}",
    get_issue: "{}",
  });

  const w = await doLinearWrite(
    { op: "create", title: "x" },
    ctx(false),
    deps(reg)
  );
  const s = await doLinearStart({ id: "ENG-1" }, ctx(false), deps(reg));

  expect(w).toContain("capability is off");
  expect(s).toContain("capability is off");
  // never touched the registry
  expect(calls.length).toBe(0);
});

test("create rejects a body that talks in line/file counts (human-intent lint)", async () => {
  const { reg, calls } = fakeRegistry({ create_issue: "{}" });

  const out = await doLinearWrite(
    {
      op: "create",
      title: "Refactor",
      description: "Changed 200 lines across 12 files.",
    },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("line/file counts");
  expect(calls.length).toBe(0);
});

test("create rejects an empty title", async () => {
  const { reg } = fakeRegistry({ create_issue: "{}" });

  expect(
    await doLinearWrite({ op: "create", title: "  " }, ctx(), deps(reg))
  ).toContain("empty");
});

test("a missing curated tool degrades to a clear message", async () => {
  const { reg } = fakeRegistry({}); // nothing exposed

  const out = await doLinearRead(
    { op: "issue", id: "ENG-1" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("exposes none of");
});

test("lintHumanText: intent passes; empty + mechanics are flagged", () => {
  expect(
    lintHumanText("Checkout is slow for large carts; make it feel instant.")
  ).toBeNull();
  expect(lintHumanText("")).toContain("empty");
  expect(lintHumanText("touched 5 files")).toContain("line/file");
});

test("resolveLinearCapability: on iff a `linear` server is connected + not killed", () => {
  expect(resolveLinearCapability({ serverNames: () => ["linear"] })).toBe(true);
  expect(resolveLinearCapability({ serverNames: () => ["notion"] })).toBe(
    false
  );
  expect(resolveLinearCapability(null)).toBe(false);
  expect(resolveLinearCapability(undefined)).toBe(false);

  process.env.TSFORGE_NO_LINEAR = "1";
  expect(resolveLinearCapability({ serverNames: () => ["linear"] })).toBe(
    false
  );
});

test("suppressCuratedSchemas drops a suppressed server's raw tools, keeps others", () => {
  const schemas = [
    {
      type: "function" as const,
      function: {
        name: "mcp__linear__list_issues",
        description: "",
        parameters: {},
      },
    },
    {
      type: "function" as const,
      function: {
        name: "mcp__notion__search",
        description: "",
        parameters: {},
      },
    },
  ];

  // no servers suppressed → passthrough
  expect(suppressCuratedSchemas(schemas, [])).toHaveLength(2);

  // suppress linear → its raw tools dropped, other servers kept
  const trimmed = suppressCuratedSchemas(schemas, ["linear"]);

  expect(trimmed.map((s) => s.function.name)).toEqual(["mcp__notion__search"]);
});
