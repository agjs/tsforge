import { test, expect } from "bun:test";
import { join } from "node:path";
import { McpRegistry, StdioMcpTransport } from "../src/mcp";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.ts");

function spawnTransport(env?: Record<string, string>): StdioMcpTransport {
  return new StdioMcpTransport("mock", {
    type: "stdio",
    command: process.execPath, // the bun binary running the tests
    args: [SERVER],
    timeoutMs: 5000,
    ...(env === undefined ? {} : { env }),
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

// P2 (review): readLoop was fire-and-forget (`void`), so when the server died
// mid-session the in-flight request waited out its full timeout and surfaced a
// misleading "timed out". The transport must instead fail fast with a clear
// connection-closed error the moment the server's stdout ends.
test("a call against a server that crashes mid-session fails fast (not a timeout)", async () => {
  const transport = spawnTransport({ MOCK_MCP_CRASH_ON_CALL: "1" });

  await transport.connect(); // initialize succeeds before the crash

  const start = performance.now();

  await expect(transport.callTool("echo", { msg: "hi" })).rejects.toThrow(
    /closed/
  );

  // It failed on the connection ending, NOT by waiting out the 5s timeout.
  expect(performance.now() - start).toBeLessThan(2000);

  await transport.close();
});
