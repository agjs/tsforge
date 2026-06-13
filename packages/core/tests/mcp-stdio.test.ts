import { test, expect } from "bun:test";
import { join } from "node:path";
import { McpRegistry, StdioMcpTransport } from "../src/mcp";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.ts");

function spawnTransport(): StdioMcpTransport {
  return new StdioMcpTransport("mock", {
    type: "stdio",
    command: process.execPath, // the bun binary running the tests
    args: [SERVER],
    timeoutMs: 5000,
  });
}

test("stdio transport: connect, list, and call a real spawned server", async () => {
  const transport = spawnTransport();

  await transport.connect();
  const tools = await transport.listTools();

  expect(tools.map((t) => t.name)).toEqual(["echo"]);

  const result = await transport.callTool("echo", { msg: "hi there" });

  expect(result).toBe("echo: hi there");

  await transport.close();
});

test("registry over a real stdio server advertises and dispatches", async () => {
  const registry = new McpRegistry();
  const count = await registry.addServer("mock", spawnTransport());

  expect(count).toBe(1);
  expect(registry.has("mcp__mock__echo")).toBe(true);

  const out = await registry.callTool("mcp__mock__echo", { msg: "yo" });

  expect(out).toBe("echo: yo");

  await registry.closeAll();
});
