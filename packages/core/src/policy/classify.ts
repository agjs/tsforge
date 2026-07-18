import { TOOL_NAME, fileArgCandidates } from "../agent";
import type { IToolCall } from "../inference";
import { normalizeWorkspacePath } from "../lib/scope";
import type { ActionKind, IProposedAction } from "./policy.types";

/** Tool name → what it actually does. Tools absent here (or any future/forged
 *  name) classify as `unknown`, which the policy never silently allows. MCP
 *  tools (`mcp__*`) are handled separately. */
const KIND_BY_TOOL: Readonly<Record<string, ActionKind>> = {
  [TOOL_NAME.read]: "read_file",
  [TOOL_NAME.search]: "read_file",
  [TOOL_NAME.symbolSearch]: "read_file",
  [TOOL_NAME.findReferences]: "read_file",
  [TOOL_NAME.typeAt]: "read_file",
  [TOOL_NAME.diagnostics]: "read_file",
  [TOOL_NAME.gitContext]: "read_file",
  [TOOL_NAME.edit]: "edit_file",
  [TOOL_NAME.editLines]: "edit_file",
  [TOOL_NAME.organizeImports]: "edit_file",
  [TOOL_NAME.renameSymbol]: "edit_file",
  [TOOL_NAME.create]: "write_file",
  [TOOL_NAME.moveFile]: "write_file",
  [TOOL_NAME.run]: "shell",
  [TOOL_NAME.addDependency]: "shell",
  // `script` runs a program that can call other tools — classify as shell so the
  // policy treats it like `run` (its stub calls are each re-classified on dispatch).
  [TOOL_NAME.script]: "shell",
  // `check` (WS-G) runs the acceptance gate on demand (bun/eslint/tsc + meta-rules)
  // — command execution with side effects, exactly like `run`/`script`, so it's
  // `shell`: allowed in the build's default mode, and plan mode still blocks it via
  // executeTool's non-read-only hard guard. WITHOUT this it classifies `unknown` →
  // deny, and every check call dies before doCheck (the spawn_agent/script regression).
  [TOOL_NAME.check]: "shell",
  // Delegating to a read-only subagent — its own class so a repo can deny/ask it
  // specifically; the child's tool calls are re-classified as they dispatch.
  [TOOL_NAME.spawnAgent]: "spawn_agent",
  [TOOL_NAME.packageInfo]: "network",
  [TOOL_NAME.packageDocs]: "network",
  [TOOL_NAME.webFetch]: "network",
  [TOOL_NAME.webSearch]: "network",
  [TOOL_NAME.webBrowse]: "network",
  // Both call an external capability endpoint → network egress is the salient
  // risk (so a repo/mode can deny/ask them like the web tools).
  [TOOL_NAME.readImage]: "network",
  [TOOL_NAME.generateImage]: "network",
};

/** Extra path-bearing arg keys beyond the file aliases (move's source/target). */
const MOVE_PATH_KEYS: readonly string[] = ["from", "to"];

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

/** Workspace-relative, normalized, deduped paths the action touches. Sourced
 *  from `fileArgCandidates` — the SAME file-alias set + coercions the handlers
 *  resolve — plus move's `from`/`to`, so a private-key/scope deny can't be
 *  dodged by naming the file `path`/`filename`/… instead of `file`. */
function extractPaths(
  args: Record<string, unknown>,
  cwd: string
): readonly string[] {
  const raw = [...fileArgCandidates(args)];

  for (const key of MOVE_PATH_KEYS) {
    const value = str(args, key);

    if (value.length > 0) {
      raw.push(value);
    }
  }

  const out: string[] = [];

  for (const value of raw) {
    const norm = normalizeWorkspacePath(cwd, value);

    if (!out.includes(norm)) {
      out.push(norm);
    }
  }

  return out;
}

/** A command preview for shell actions (the literal `run` command, or the
 *  `bun add …` line `add_dependency` would build). Undefined for non-shell. */
function extractCommand(
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  if (toolName === TOOL_NAME.run) {
    return str(args, "command");
  }

  if (toolName === TOOL_NAME.addDependency) {
    return `bun add ${str(args, "packages")}`.trim();
  }

  return undefined;
}

/**
 * Reduce a tool call to an `IProposedAction` the policy can evaluate. Reuses the
 * existing `normalizeWorkspacePath` so policy sees the same path form the write
 * guards do. Unknown/forged names → `kind:"unknown"`; `mcp__<server>__<tool>` →
 * `mcp_tool` with the parsed server.
 */
export function classifyAction(call: IToolCall, cwd: string): IProposedAction {
  const args = call.arguments;

  if (call.name.startsWith("mcp__")) {
    return {
      kind: "mcp_tool",
      toolName: call.name,
      input: args,
      cwd,
      mcpServer: call.name.split("__")[1] ?? "",
    };
  }

  const kind = KIND_BY_TOOL[call.name] ?? "unknown";
  const paths = extractPaths(args, cwd);
  const command = extractCommand(call.name, args);

  const action: IProposedAction = {
    kind,
    toolName: call.name,
    input: args,
    cwd,
  };

  if (paths.length > 0) {
    action.paths = paths;
  }

  if (command !== undefined) {
    action.command = command;
  }

  return action;
}
