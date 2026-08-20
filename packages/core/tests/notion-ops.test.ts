import { test, expect, afterEach } from "bun:test";
import {
  doNotionRead,
  doNotionWrite,
  resolveNotionCapability,
} from "../src/loop/tools/notion-ops";
import type { IIntegrationRegistry } from "../src/loop/tools/integration-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (notion = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  notion,
});

function fakeRegistry(tools: Record<string, string>): {
  reg: IIntegrationRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const reg: IIntegrationRegistry = {
    has: (name) => Object.keys(tools).some((s) => name === `mcp__notion__${s}`),
    callTool: async (name, args) => {
      calls.push({ name, args });

      return tools[name.replace("mcp__notion__", "")] ?? "unknown MCP tool";
    },
  };

  return { reg, calls };
}

afterEach(() => {
  delete process.env.TSFORGE_NO_NOTION;
});

test("search lists pages from a {results:[...]} payload", async () => {
  const { reg } = fakeRegistry({
    search: JSON.stringify({
      results: [
        { title: "Onboarding", id: "p1", url: "https://n/p1" },
        { title: "Runbook", id: "p2" },
      ],
    }),
  });

  const out = await doNotionRead({ op: "search", query: "onboard" }, ctx(), {
    registry: reg,
  });

  expect(out).toContain("Onboarding");
  expect(out).toContain("(p1)");
  expect(out).toContain("Runbook");
});

test("page reads a page's title and content, tolerating the tool-name variant", async () => {
  const { reg, calls } = fakeRegistry({
    retrieve_page: JSON.stringify({
      title: "Deploy Runbook",
      url: "https://n/p2",
      content: "Step 1. Do the thing.",
    }),
  });

  const out = await doNotionRead({ op: "page", id: "p2" }, ctx(), {
    registry: reg,
  });

  expect(out).toContain("Deploy Runbook");
  expect(out).toContain("Step 1. Do the thing.");
  expect(calls[0]?.name).toBe("mcp__notion__retrieve_page");
});

test("create returns the new page url and passes the parent", async () => {
  const { reg, calls } = fakeRegistry({
    create_page: JSON.stringify({ url: "https://n/new" }),
  });

  const out = await doNotionWrite(
    {
      op: "create",
      title: "Decision: use X",
      content: "We chose X because it keeps the flow simple.",
      parent: "root",
    },
    ctx(),
    { registry: reg }
  );

  expect(out).toContain("https://n/new");
  expect(calls[0]?.args.parent).toBe("root");
});

test("write fails closed when the notion capability is off", async () => {
  const { reg, calls } = fakeRegistry({ create_page: "{}" });

  const out = await doNotionWrite({ op: "create", title: "x" }, ctx(false), {
    registry: reg,
  });

  expect(out).toContain("capability is off");
  expect(calls.length).toBe(0);
});

test("append needs a page id and non-empty content", async () => {
  const { reg } = fakeRegistry({ append_block_children: "{}" });

  expect(
    await doNotionWrite({ op: "append", content: "note" }, ctx(), {
      registry: reg,
    })
  ).toContain("page `id`");
  expect(
    await doNotionWrite({ op: "append", id: "p1", content: "" }, ctx(), {
      registry: reg,
    })
  ).toContain("empty");
});

test("resolveNotionCapability keys off a connected `notion` server", () => {
  expect(resolveNotionCapability({ serverNames: () => ["notion"] })).toBe(true);
  expect(resolveNotionCapability({ serverNames: () => ["linear"] })).toBe(
    false
  );

  process.env.TSFORGE_NO_NOTION = "1";
  expect(resolveNotionCapability({ serverNames: () => ["notion"] })).toBe(
    false
  );
});

test("unknown op is rejected", async () => {
  const { reg } = fakeRegistry({});

  expect(
    await doNotionRead({ op: "delete" }, ctx(), { registry: reg })
  ).toContain("unknown op");
});
