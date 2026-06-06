import type { IToolCall } from "../inference/types";
import { TOOL_NAME, type ToolName } from "../agent/tools";
import { readFile, runShell, doEdit, doCreate } from "./file-ops";
import { doSearch, doLsp } from "./lsp-ops";
import { type IToolContext } from "./tool-context";

export type { IToolContext } from "./tool-context";

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: IToolContext
) => Promise<string> | string;

/** Name → handler. The LSP entries close over their tool name so `doLsp` keeps
 *  one body. Keyed by ToolName, so a new tool must register here (exhaustive). */
const HANDLERS: Record<ToolName, ToolHandler> = {
  [TOOL_NAME.read]: readFile,
  [TOOL_NAME.run]: runShell,
  [TOOL_NAME.edit]: doEdit,
  [TOOL_NAME.create]: doCreate,
  [TOOL_NAME.search]: doSearch,
  [TOOL_NAME.symbolSearch]: (a, c) => doLsp(TOOL_NAME.symbolSearch, a, c),
  [TOOL_NAME.findReferences]: (a, c) => doLsp(TOOL_NAME.findReferences, a, c),
  [TOOL_NAME.typeAt]: (a, c) => doLsp(TOOL_NAME.typeAt, a, c),
  [TOOL_NAME.diagnostics]: (a, c) => doLsp(TOOL_NAME.diagnostics, a, c),
  [TOOL_NAME.renameSymbol]: (a, c) => doLsp(TOOL_NAME.renameSymbol, a, c),
  [TOOL_NAME.organizeImports]: (a, c) => doLsp(TOOL_NAME.organizeImports, a, c),
};

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(HANDLERS, name);
}

/**
 * Perform one tool call and return the text result fed back to the model as a
 * tool message. Dispatch only — the handlers live in file-ops (read/run/edit/
 * create) and lsp-ops (search + the semantic tools); scope enforcement and arg
 * parsing live with each handler (tool-context holds the shared helpers).
 */
export async function executeTool(
  call: IToolCall,
  ctx: IToolContext
): Promise<string> {
  if (!isToolName(call.name)) {
    return `unknown tool: ${call.name}`;
  }

  return HANDLERS[call.name](call.arguments, ctx);
}
