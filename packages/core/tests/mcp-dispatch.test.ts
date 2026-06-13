import { test, expect } from "bun:test";
import { executeTool, type IToolContext } from "../src/loop/tools";
import { McpRegistry, type IMcpToolInfo, type IMcpTransport } from "../src/mcp";

const ECHO_TOOL: IMcpToolInfo = {
  name: "echo",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

class EchoTransport implements IMcpTransport {
  connect(): Promise<void> {
    return Promise.resolve();
  }

  listTools(): Promise<IMcpToolInfo[]> {
    return Promise.resolve([ECHO_TOOL]);
  }

  callTool(_name: string, args: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`echo:${JSON.stringify(args)}`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function registryWithEcho(): Promise<McpRegistry> {
  const registry = new McpRegistry();

  await registry.addServer("ctx7", new EchoTransport());

  return registry;
}

function baseCtx(registry: McpRegistry, readOnly: boolean): IToolContext {
  return {
    cwd: ".",
    files: ["**/*"],
    task: "t",
    report: () => undefined,
    mcpRegistry: registry,
    readOnly,
  };
}

test("executeTool routes mcp__ calls to the registry", async () => {
  const ctx = baseCtx(await registryWithEcho(), false);

  const out = await executeTool(
    { name: "mcp__ctx7__echo", arguments: { msg: "hi" } },
    ctx
  );

  expect(out).toBe('echo:{"msg":"hi"}');
});

test("executeTool: MCP tools are allowed in plan/read-only mode", async () => {
  const ctx = baseCtx(await registryWithEcho(), true);

  const out = await executeTool(
    { name: "mcp__ctx7__echo", arguments: {} },
    ctx
  );

  expect(out).not.toContain("plan mode");
  expect(out).toBe("echo:{}");
});

test("executeTool: an unknown non-MCP tool is still rejected", async () => {
  const ctx = baseCtx(await registryWithEcho(), false);

  const out = await executeTool({ name: "bogus", arguments: {} }, ctx);

  expect(out).toContain("unknown tool");
});
