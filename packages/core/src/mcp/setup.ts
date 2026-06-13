import type { IMcpServerConfig } from "./mcp.types";
import { McpRegistry } from "./registry";
import { StdioMcpTransport } from "./stdio-transport";

/**
 * Connect every configured MCP server and return a registry, or null if none are
 * configured or none connected. Per-server failures are reported and skipped so
 * a single bad server can never block the run. Only the stdio transport is wired
 * today; http entries are reported and skipped.
 */
export async function connectMcpServers(
  servers: Readonly<Record<string, IMcpServerConfig>>,
  report: (message: string) => void
): Promise<McpRegistry | null> {
  const names = Object.keys(servers);

  if (names.length === 0) {
    return null;
  }

  const registry = new McpRegistry();

  for (const name of names) {
    const config = servers[name];

    if (config === undefined) {
      continue;
    }

    if (config.type === "http") {
      report(
        `MCP server '${name}': http transport not yet supported (stdio only)`
      );

      continue;
    }

    try {
      const count = await registry.addServer(
        name,
        new StdioMcpTransport(name, config)
      );

      report(`MCP server '${name}': ${count} tool(s) registered`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      report(`MCP server '${name}' failed to connect: ${message}`);
    }
  }

  return registry.size > 0 ? registry : null;
}
