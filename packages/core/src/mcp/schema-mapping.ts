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

/** OpenAI function names allow [a-zA-Z0-9_-]; replace anything else with "_". */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The namespaced name advertised to the model for an MCP tool. The double-underscore
 *  separators mirror the conventional `mcp__<server>__<tool>` form. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;
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
