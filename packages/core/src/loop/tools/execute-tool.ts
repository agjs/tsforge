import type { IToolCall } from "../../inference";
import { TOOL_NAME, READ_ONLY_TOOL_NAMES, type ToolName } from "../../agent";
import { readFile, runShell, doEdit, doCreate } from "./file-ops";
import { doHashlineEdit } from "./edit-hashline";
import { doSearch, doLsp } from "./lsp-ops";
import { doGit } from "./git-ops";
import { doScaffoldUi } from "./scaffold-ui";
import { doScaffoldRoutes } from "./scaffold-routes";
import { doScaffoldWeb } from "./scaffold-web";
import { doAddDependency } from "./add-dependency";
import { doWebFetch } from "./web-fetch";
import { doWebSearch } from "./web-search";
import { doWebBrowse } from "./web-browse";
import { doPackageInfo, doPackageDocs } from "./package-info";
import { doScript } from "./script-tool";
import { reject, type IToolContext } from "./tool-context";
import {
  classifyAction,
  evaluatePolicy,
  type IPolicyContext,
} from "../../policy";

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
  [TOOL_NAME.gitContext]: doGit,
  [TOOL_NAME.scaffoldUi]: doScaffoldUi,
  [TOOL_NAME.scaffoldRoutes]: doScaffoldRoutes,
  [TOOL_NAME.scaffoldWeb]: doScaffoldWeb,
  [TOOL_NAME.addDependency]: doAddDependency,
  [TOOL_NAME.packageInfo]: doPackageInfo,
  [TOOL_NAME.packageDocs]: doPackageDocs,
  [TOOL_NAME.webFetch]: doWebFetch,
  [TOOL_NAME.webSearch]: doWebSearch,
  [TOOL_NAME.webBrowse]: doWebBrowse,
  // The script's stubs RPC back into executeTool — passed as `execute` here so
  // script-tool.ts never imports this module (no cycle), and a nested `script`
  // call is rejected (script is not in SCRIPT_EXPOSABLE_TOOLS).
  [TOOL_NAME.script]: (a, c) => doScript(a, c, { execute: executeTool }),
  // yield_status is intercepted by the Session BEFORE tool dispatch (it ends the
  // turn); this handler only fires if one slips through with other calls.
  [TOOL_NAME.yieldStatus]: () =>
    "(turn continues — finish the work, then yield alone)",
};

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(HANDLERS, name);
}

/** Build the policy context from the ambient tool context. Mode defaults to
 *  `"default"` (drive-to-green) when unset; MCP server names come from the
 *  registry so a forged/unregistered `mcp__*` call is a critical deny. */
function policyContextFrom(ctx: IToolContext): IPolicyContext {
  const servers = ctx.mcpRegistry?.serverNames();

  return {
    mode: ctx.policyMode ?? "default",
    cwd: ctx.cwd,
    files: ctx.files,
    interactive: ctx.interactive ?? false,
    ...(servers === undefined ? {} : { mcpServers: servers }),
    ...(ctx.policyRules === undefined ? {} : { rules: ctx.policyRules }),
  };
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
  // UNIFIED POLICY (deny-first), evaluated BEFORE any routing so it wraps
  // built-in, MCP, plugin, and unknown tools alike. Tool-local guards (scope,
  // vendored, SSRF, argv) still run afterwards — policy is an outer layer, not a
  // replacement. The model proposes; the harness enforces.
  const action = classifyAction(call, ctx.cwd);
  const verdict = evaluatePolicy(action, policyContextFrom(ctx));

  // A typed ledger signal for every decision (renders to nothing on screen).
  ctx.report({
    kind: "policy",
    task: ctx.task,
    message: `${action.kind} ${call.name}: ${verdict.reason}`,
    decision: verdict.decision,
    risk: verdict.risk,
    rules: verdict.matchedRules,
  });

  if (verdict.decision !== "allow") {
    return reject(
      ctx,
      call.name,
      `policy ${verdict.decision}: ${verdict.reason}`
    );
  }

  // MCP tools (mcp__<server>__<tool>) are dispatched to their server. They are
  // external context sources — never workspace mutations.
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

  // Error boundary: a handler must hand the model a tool-error STRING, never throw
  // into the loop (an unguarded `Bun.write` EACCES, a parse failure, etc. would
  // otherwise crash `runToolCalls` mid-turn). Catch only the built-in dispatch —
  // policy/MCP/unknown above already return text. Mutating handlers roll back their
  // own partial writes (writeFilesOrRollback), so a caught throw left disk clean.
  try {
    return await HANDLERS[call.name](call.arguments, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return reject(ctx, call.name, `${call.name} FAILED: ${message}`);
  }
}
