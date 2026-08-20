import { test, expect, afterEach } from "bun:test";
import {
  doSentryRead,
  doSentryWrite,
  resolveSentryCapability,
} from "../src/loop/tools/sentry-ops";
import type { IIntegrationRegistry } from "../src/loop/tools/integration-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (sentry = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  sentry,
});

function fakeRegistry(tools: Record<string, string>): {
  reg: IIntegrationRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const reg: IIntegrationRegistry = {
    has: (name) => Object.keys(tools).some((s) => name === `mcp__sentry__${s}`),
    callTool: async (name, args) => {
      calls.push({ name, args });

      return tools[name.replace("mcp__sentry__", "")] ?? "unknown MCP tool";
    },
  };

  return { reg, calls };
}

afterEach(() => {
  delete process.env.TSFORGE_NO_SENTRY;
});

test("issue summarizes the error, count, and stacktrace", async () => {
  const { reg, calls } = fakeRegistry({
    get_issue_details: JSON.stringify({
      shortId: "APP-42",
      title: "TypeError: cannot read 'id'",
      culprit: "checkout/pay.ts in submit",
      level: "error",
      status: "unresolved",
      count: 137,
      permalink: "https://sentry.io/app-42",
      stacktrace: "at submit (checkout/pay.ts:88)\nat onClick (Button.tsx:12)",
    }),
  });

  const out = await doSentryRead({ op: "issue", id: "APP-42" }, ctx(), {
    registry: reg,
  });

  expect(out).toContain("APP-42 TypeError: cannot read 'id'");
  expect(out).toContain("seen: 137×");
  expect(out).toContain("checkout/pay.ts:88");
  expect(out).toContain("https://sentry.io/app-42");
  expect(calls[0]?.args.issueId).toBe("APP-42");
});

test("search lists issues with level and count", async () => {
  const { reg } = fakeRegistry({
    search_issues: JSON.stringify([
      { shortId: "APP-1", title: "Boom", level: "error", count: 9 },
      { shortId: "APP-2", title: "Warn", level: "warning", count: 3 },
    ]),
  });

  const out = await doSentryRead(
    { op: "search", query: "is:unresolved" },
    ctx(),
    {
      registry: reg,
    }
  );

  expect(out).toContain("APP-1 Boom [error] (9×)");
  expect(out).toContain("APP-2 Warn [warning] (3×)");
});

test("resolve marks the issue resolved via update_issue", async () => {
  const { reg, calls } = fakeRegistry({
    update_issue: JSON.stringify({ ok: true }),
  });

  const out = await doSentryWrite({ op: "resolve", id: "APP-42" }, ctx(), {
    registry: reg,
  });

  expect(out).toContain("resolved APP-42");
  expect(calls[0]?.args.status).toBe("resolved");
});

test("write fails closed when the sentry capability is off", async () => {
  const { reg, calls } = fakeRegistry({ update_issue: "{}" });

  const out = await doSentryWrite({ op: "resolve", id: "APP-1" }, ctx(false), {
    registry: reg,
  });

  expect(out).toContain("capability is off");
  expect(calls.length).toBe(0);
});

test("resolve needs an id; unknown write op rejected", async () => {
  const { reg } = fakeRegistry({ update_issue: "{}" });

  expect(
    await doSentryWrite({ op: "resolve" }, ctx(), { registry: reg })
  ).toContain("needs an issue `id`");
  expect(
    await doSentryWrite({ op: "delete", id: "APP-1" }, ctx(), { registry: reg })
  ).toContain("unknown op");
});

test("resolveSentryCapability keys off a connected `sentry` server", () => {
  expect(resolveSentryCapability({ serverNames: () => ["sentry"] })).toBe(true);
  expect(resolveSentryCapability({ serverNames: () => ["notion"] })).toBe(
    false
  );

  process.env.TSFORGE_NO_SENTRY = "1";
  expect(resolveSentryCapability({ serverNames: () => ["sentry"] })).toBe(
    false
  );
});
