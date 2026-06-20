import { repairArgs } from "../../agent/tool-repair";
import type { TsService } from "../../lsp";
import type { Reporter } from "../loop.types";
import type { SessionSnapshotStore } from "../../files/hashline";
import type { McpRegistry } from "../../mcp";
import type { PolicyMode, IPolicyRules } from "../../policy";

/** Turn a workspace into a web project. Resolves with the files actually written
 *  (mutation accounting / re-gate) and whether dependency install succeeded. The
 *  optional `signal` lets the caller cancel the (potentially slow) dependency
 *  install when the turn is aborted (Ctrl-C), not just on the kill-timeout. */
export type SetupWebFn = (
  framework: string,
  options?: { signal?: AbortSignal }
) => Promise<{ files: readonly string[]; depsInstalled: boolean }>;

export interface IToolContext {
  cwd: string;
  /** Editable scope — `edit`/`create` outside it are rejected. */
  files: string[];
  report: Reporter;
  task: string;
  /** In-process TypeScript LanguageService — backs the semantic tools
   *  (rename/type_at/find_references/symbol_search/diagnostics/organize_imports).
   *  Null when the project has no tsconfig. */
  tsService?: TsService | null;
  /** Cancellation for the in-flight turn — passed to the `run` tool (and search)
   *  so a model-issued command is killed on Ctrl-C, not left running. */
  signal?: AbortSignal;
  /** Turn this workspace into a web project: scaffold the stack + deps and switch
   *  the session to the web gate/guidance. Wired by the interactive CLI so the
   *  AGENT decides whether to scaffold (via the `scaffold_web` tool) instead of a
   *  brittle up-front classifier. Absent where unsupported (headless already
   *  scaffolds up front), in which case the tool reports it's unavailable.
   *  Resolves with the files it actually wrote (for mutation accounting / re-gate)
   *  and whether dependency install succeeded (so the tool can tell the model the
   *  truth instead of always claiming "deps installed"). */
  setupWeb?: SetupWebFn;
  /** PLAN MODE: mutating tools are rejected at dispatch and `run` only accepts
   *  read-only commands — the hard guarantee behind the filtered tool list (a
   *  salvaged/forced call could otherwise still write). */
  readOnly?: boolean;
  /** Active policy mode for the unified action-policy layer (executeTool runs
   *  every call through `evaluatePolicy` first). Absent ⇒ `"default"` (the
   *  autonomous drive-to-green default), so existing call sites are unchanged. */
  policyMode?: PolicyMode;
  /** Config-driven policy rules (deny/allow/ask), evaluated before the mode
   *  default. Absent ⇒ mode default only. */
  policyRules?: IPolicyRules;
  /** Whether a real interactive per-action approval path exists. Absent/false ⇒
   *  a policy `ask` resolves to `deny` (no approval UI today). */
  interactive?: boolean;
  /** Hashline snapshot store for stale-anchor recovery (per-session, lazily initialized). */
  snapshotStore?: SessionSnapshotStore;
  /** Connected MCP servers. When present, `mcp__<server>__<tool>` calls are routed
   *  here. These are external context/tool sources — they never touch the editable
   *  scope or the deterministic gate. Absent ⇒ no MCP configured. */
  mcpRegistry?: McpRegistry;
}

/** A required string arg, or "" if missing/wrong-type. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

export interface IParseResult<T> {
  value: T | null;
  feedback?: string; // L3 feedback when recoverable=false
}

/**
 * Parse a tool's args, with VALIDATE-THEN-REPAIR: try the tool's own parser; if
 * it rejects, apply the repair ladder (L0→L1→L2→L3). Emits telemetry:
 *   - `repair:L0:<rule>` / `repair:L1:<rule>` / `repair:L2:<rule>` per applied rule
 *   - `repair:L3` when re-asking (feedback included in result)
 *   - `tool_input_rejected:<tool>` when (rarely) no parse succeeded
 * Returns both the parsed value and optional L3 feedback to surface to the model.
 */
export function parseOrRepair<T>(
  raw: Record<string, unknown>,
  normalize: (a: Record<string, unknown>) => T | null,
  ctx: IToolContext,
  tool: string
): IParseResult<T> {
  const direct = normalize(raw);

  if (direct !== null) {
    return { value: direct };
  }

  const repair = repairArgs(raw);

  if (repair.applied.length > 0) {
    for (const rule of repair.applied) {
      ctx.report({
        kind: "repair",
        task: ctx.task,
        message: `${tool}:${rule}`,
      });
    }
  }

  const repaired = repair.applied.length > 0 ? normalize(repair.args) : null;

  if (repaired !== null) {
    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `tool_input_repaired:${tool} (${repair.applied.join(", ")})`,
    });

    return { value: repaired };
  }

  // L3: If still broken after L0-L2, return feedback if provided (recoverable=false).
  if (
    !repair.recoverable &&
    repair.feedback !== undefined &&
    repair.feedback.length > 0
  ) {
    ctx.report({
      kind: "repair",
      task: ctx.task,
      message: `${tool}:L3-re-ask`,
    });

    return { value: null, feedback: repair.feedback };
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_input_rejected:${tool}`,
  });

  return { value: null };
}

/** Log a tool rejection (scope / size / match failure) so it's measurable. */
export function reject(
  ctx: IToolContext,
  tool: string,
  reason: string
): string {
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_rejected:${tool} (${reason})`,
  });

  return reason;
}
