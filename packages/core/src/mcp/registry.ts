import type { IMcpTransport } from "./mcp.types";
import { mapMcpTool, mcpToolName, type IToolSchema } from "./schema-mapping";

interface IRegisteredTool {
  readonly server: string;
  readonly toolName: string;
  readonly transport: IMcpTransport;
}

/**
 * Holds the live MCP connections and the tools they expose. Tools are advertised
 * to the model under a namespaced `mcp__<server>__<tool>` name and dispatched back
 * to the owning transport. Designed to fail soft: a tool call that throws is
 * returned as text (the model sees a tool failure and adapts) rather than
 * crashing the agent loop.
 */
export class McpRegistry {
  private readonly schemas: IToolSchema[] = [];
  private readonly byName = new Map<string, IRegisteredTool>();
  private readonly transports: IMcpTransport[] = [];

  /** Connect a server, list its tools, and register each under its namespaced
   *  name. Returns the number of tools registered. May reject if the server
   *  fails to connect or list — the caller catches per-server so one bad server
   *  does not abort startup. */
  async addServer(server: string, transport: IMcpTransport): Promise<number> {
    await transport.connect();
    this.transports.push(transport);

    const tools = await transport.listTools();
    let count = 0;

    for (const tool of tools) {
      const name = mcpToolName(server, tool.name);

      if (this.byName.has(name)) {
        continue;
      }

      this.byName.set(name, { server, toolName: tool.name, transport });
      this.schemas.push(mapMcpTool(server, tool));
      count += 1;
    }

    return count;
  }

  /** Tool schemas to append to the model's advertised tool list. */
  toolSchemas(): IToolSchema[] {
    return [...this.schemas];
  }

  /** Number of registered MCP tools. */
  get size(): number {
    return this.byName.size;
  }

  /** True if `name` is a registered MCP tool. */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Call a registered MCP tool. Never throws: a transport failure is returned
   *  as text so the model treats it as a tool result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.byName.get(name);

    if (entry === undefined) {
      return `unknown MCP tool: ${name}`;
    }

    try {
      return await entry.transport.callTool(entry.toolName, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      return `MCP tool '${name}' failed: ${message}`;
    }
  }

  /** Close every connected transport (best effort). */
  async closeAll(): Promise<void> {
    for (const transport of this.transports) {
      try {
        await transport.close();
      } catch {
        // best effort — a server that already died needs no clean shutdown
      }
    }
  }
}
