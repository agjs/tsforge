import { repairArgs } from "../../agent/tool-repair";
import type { TsService } from "../../lsp";
import type { Reporter } from "../loop.types";

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
   *  scaffolds up front), in which case the tool reports it's unavailable. */
  setupWeb?: (framework: string) => Promise<void>;
  /** PLAN MODE: mutating tools are rejected at dispatch and `run` only accepts
   *  read-only commands — the hard guarantee behind the filtered tool list (a
   *  salvaged/forced call could otherwise still write). */
  readOnly?: boolean;
}

/** A required string arg, or "" if missing/wrong-type. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

/**
 * Parse a tool's args, with VALIDATE-THEN-REPAIR: try the tool's own parser; if
 * it rejects, apply the generic input repairs and try ONCE more. Emits telemetry
 * — `tool_input_repaired:<tool>` when a repair rescued the call,
 * `tool_input_rejected:<tool>` when even repair couldn't — so we can watch
 * per-tool failure rates as the toolset grows.
 */
export function parseOrRepair<T>(
  raw: Record<string, unknown>,
  normalize: (a: Record<string, unknown>) => T | null,
  ctx: IToolContext,
  tool: string
): T | null {
  const direct = normalize(raw);

  if (direct !== null) {
    return direct;
  }

  const { args, applied } = repairArgs(raw);
  const repaired = applied.length > 0 ? normalize(args) : null;

  if (repaired !== null) {
    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `tool_input_repaired:${tool} (${applied.join(", ")})`,
    });

    return repaired;
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_input_rejected:${tool}`,
  });

  return null;
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
