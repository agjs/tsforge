import type { IToolCall } from "../../inference";
import { TOOL_NAME, READ_ONLY_TOOL_NAMES, type ToolName } from "../../agent";
import { readFile, runShell, doEdit, doCreate } from "./file-ops";
import { doHashlineEdit } from "./edit-hashline";
import { doSearch, doLsp } from "./lsp-ops";
import { doScaffoldUi } from "./scaffold-ui";
import { doScaffoldRoutes } from "./scaffold-routes";
import { doScaffoldWeb } from "./scaffold-web";
import { doAddDependency } from "./add-dependency";
import { doWebFetch } from "./web-fetch";
import { doWebSearch } from "./web-search";
import { reject, type IToolContext } from "./tool-context";

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
  [TOOL_NAME.editLines]: doHashlineEdit,
  [TOOL_NAME.create]: doCreate,
  [TOOL_NAME.search]: doSearch,
  [TOOL_NAME.symbolSearch]: (a, c) => doLsp(TOOL_NAME.symbolSearch, a, c),
  [TOOL_NAME.findReferences]: (a, c) => doLsp(TOOL_NAME.findReferences, a, c),
  [TOOL_NAME.typeAt]: (a, c) => doLsp(TOOL_NAME.typeAt, a, c),
  [TOOL_NAME.diagnostics]: (a, c) => doLsp(TOOL_NAME.diagnostics, a, c),
  [TOOL_NAME.renameSymbol]: (a, c) => doLsp(TOOL_NAME.renameSymbol, a, c),
  [TOOL_NAME.moveFile]: (a, c) => doLsp(TOOL_NAME.moveFile, a, c),
  [TOOL_NAME.organizeImports]: (a, c) => doLsp(TOOL_NAME.organizeImports, a, c),
  [TOOL_NAME.scaffoldUi]: doScaffoldUi,
  [TOOL_NAME.scaffoldRoutes]: doScaffoldRoutes,
  [TOOL_NAME.scaffoldWeb]: doScaffoldWeb,
  [TOOL_NAME.addDependency]: doAddDependency,
  [TOOL_NAME.webFetch]: doWebFetch,
  [TOOL_NAME.webSearch]: doWebSearch,
  // yield_status is intercepted by the Session BEFORE tool dispatch (it ends the
  // turn); this handler only fires if one slips through with other calls.
  [TOOL_NAME.yieldStatus]: () =>
    "(turn continues — finish the work, then yield alone)",
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
  // MCP tools (mcp__<server>__<tool>) are dispatched to their server. They are
  // external context sources — never workspace mutations — so they bypass the
  // built-in name table and the plan-mode write guard below.
  if (ctx.mcpRegistry?.has(call.name) === true) {
    return ctx.mcpRegistry.callTool(call.name, call.arguments);
  }

  if (!isToolName(call.name)) {
    return `unknown tool: ${call.name}`;
  }

  // PLAN MODE hard guard: the advertised tool list already omits mutating tools,
  // but a salvaged/forced call can name anything — reject it here so plan mode
  // is a guarantee, not a convention. (`run` passes; its handler enforces a
  // read-only command allowlist.)
  if (
    ctx.readOnly === true &&
    !READ_ONLY_TOOL_NAMES.has(call.name) &&
    call.name !== TOOL_NAME.run
  ) {
    return reject(
      ctx,
      call.name,
      `plan mode: \`${call.name}\` is disabled — explore with read-only tools and ` +
        "present your plan as text; the user must approve it before files can change."
    );
  }

  return HANDLERS[call.name](call.arguments, ctx);
}
