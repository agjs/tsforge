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
