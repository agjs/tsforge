import type { IMcpToolInfo } from "./mcp.types";

/** A tool schema in the OpenAI "function" wire shape the model is given. */
export interface IToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** OpenAI function names allow [a-zA-Z0-9_-]; replace anything else with "_".
 *  This is the canonical MCP name normalization: the wire tool name the model
 *  sees is `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`, so the
 *  SANITIZED server segment is the identity the policy layer parses back out of
 *  a call name. Anything comparing against that identity (the registered-server
 *  check) must sanitize too, or a server whose config name has a `.`/space is
 *  advertised under one name but checked under another → wrongly denied. */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The namespaced name advertised to the model for an MCP tool. The double-underscore
 *  separators mirror the conventional `mcp__<server>__<tool>` form. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`;
}

/** A tool with no declared parameters still needs a valid object schema. */
function paramsOrEmptyObject(
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(schema).length === 0) {
    return { type: "object", properties: {} };
  }

  return schema;
}

/** Map one MCP tool to the OpenAI function schema the model is given. */
export function mapMcpTool(server: string, tool: IMcpToolInfo): IToolSchema {
  return {
    type: "function",
    function: {
      name: mcpToolName(server, tool.name),
      description: tool.description ?? `${server}: ${tool.name}`,
      parameters: paramsOrEmptyObject(tool.inputSchema),
    },
  };
}
