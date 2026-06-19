import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, type IToolContext } from "../src/loop/tools";
import { McpRegistry } from "../src/mcp";
import type { PolicyMode } from "../src/policy";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-policy-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(
  dir: string,
  mode: PolicyMode,
  over: Partial<IToolContext> = {}
): IToolContext {
  return {
    cwd: dir,
    files: ["**/*.ts"],
    task: "t",
    report: () => undefined,
    policyMode: mode,
    ...over,
  };
}

describe("policy integration — every tool routes through the policy", () => {
  test("plan mode denies create/edit/edit_lines via policy (nothing written)", async () => {
    await withDir(async (dir) => {
      for (const call of [
        { name: "create", arguments: { file: "a.ts", content: "x" } },
        {
          name: "edit",
          arguments: { file: "a.ts", oldString: "x", newString: "y" },
        },
        {
          name: "edit_lines",
          arguments: { file: "a.ts", input: "replace 1..1:\n+z" },
        },
      ]) {
        const out = await executeTool(call, ctx(dir, "plan"));

        expect(out.toLowerCase()).toContain("policy deny");
        expect(out).toContain("plan mode is read-only");
      }

      expect(await Bun.file(join(dir, "a.ts")).exists()).toBe(false);
    });
  });

  test("ci mode denies model shell via policy", async () => {
    await withDir(async (dir) => {
      const out = await executeTool(
        { name: "run", arguments: { command: "bun test" } },
        ctx(dir, "ci")
      );

      expect(out.toLowerCase()).toContain("policy deny");
    });
  });

  test("acceptEdits denies network tools via policy", async () => {
    await withDir(async (dir) => {
      const out = await executeTool(
        { name: "web_fetch", arguments: { url: "https://example.com" } },
        ctx(dir, "acceptEdits")
      );

      expect(out.toLowerCase()).toContain("policy deny");
    });
  });

  test("destructive shell is denied in default — the handler never runs", async () => {
    await withDir(async (dir) => {
      const canary = join(dir, "canary.txt");

      await Bun.write(canary, "alive");

      const out = await executeTool(
        { name: "run", arguments: { command: `rm -f ${canary}` } },
        ctx(dir, "default")
      );

      expect(out.toLowerCase()).toContain("policy deny");
      expect(out).toContain("destructive");
      // The handler was never reached, so the file is untouched.
      expect(await Bun.file(canary).text()).toBe("alive");
    });
  });

  test("unknown tool is denied by policy (never silently executes)", async () => {
    await withDir(async (dir) => {
      const out = await executeTool(
        { name: "definitely_not_a_tool", arguments: {} },
        ctx(dir, "default")
      );

      expect(out.toLowerCase()).toContain("policy deny");
    });
  });

  test("MCP tools route through policy: plan denies, unregistered server denied", async () => {
    await withDir(async (dir) => {
      // plan mode denies any mcp tool (before routing)
      const planned = await executeTool(
        { name: "mcp__github__create_issue", arguments: {} },
        ctx(dir, "plan", { mcpRegistry: new McpRegistry() })
      );

      expect(planned.toLowerCase()).toContain("policy deny");

      // default mode, but the server isn't registered → critical deny
      const unregistered = await executeTool(
        { name: "mcp__evil__exfiltrate", arguments: {} },
        ctx(dir, "default", { mcpRegistry: new McpRegistry() })
      );

      expect(unregistered.toLowerCase()).toContain("policy deny");
      expect(unregistered).toContain("unregistered MCP server");
    });
  });

  test("default mode preserves normal scoped work (create writes the file)", async () => {
    await withDir(async (dir) => {
      const out = await executeTool(
        {
          name: "create",
          arguments: { file: "ok.ts", content: "export const x = 1;\n" },
        },
        ctx(dir, "default")
      );

      expect(out.toLowerCase()).not.toContain("policy deny");
      expect(await Bun.file(join(dir, "ok.ts")).exists()).toBe(true);
    });
  });
});
