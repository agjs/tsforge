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

// ── C2: a throwing MCP tool must return an error STRING, never throw ─────────
// If an MCP rejection ever escaped, it would unwind runToolCalls before the
// tool RESPONSE message was pushed — an assistant tool_calls with no tool
// responses, which strict APIs 400 on every later request, and which got
// persisted for --continue. The registry catches transport errors and
// executeTool now has its own boundary around the dispatch (defense in depth:
// a registry regression must not become invalid history).
class CrashingTransport implements IMcpTransport {
  connect(): Promise<void> {
    return Promise.resolve();
  }

  listTools(): Promise<IMcpToolInfo[]> {
    return Promise.resolve([ECHO_TOOL]);
  }

  callTool(): Promise<string> {
    return Promise.reject(new Error("MCP server timed out"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

test("executeTool: a rejecting MCP server yields a tool-error string (no throw)", async () => {
  const registry = new McpRegistry();

  await registry.addServer("ctx7", new CrashingTransport());

  const ctx = baseCtx(registry, false);
  const out = await executeTool(
    { name: "mcp__ctx7__echo", arguments: {} },
    ctx
  );

  expect(out).toContain("failed");
  expect(out).toContain("MCP server timed out");
});
