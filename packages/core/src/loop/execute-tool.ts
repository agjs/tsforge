import { join, relative } from "node:path";
import { repairArgs } from "../agent/tool-repair";
import {
  fileArg,
  runCommand,
  toCreate,
  toEdits,
  TOOL_NAME,
  toRead,
  toRun,
  type ToolName,
} from "../agent/tools";
import { LIMITS } from "../constants";
import { applyCreate } from "../files/create";
import { applyEdits } from "../files/edit";
import { EDIT_FAIL_REASON } from "../files/types";
import type { IToolCall } from "../inference/types";
import { writable } from "../lib/scope";
import type { TsService } from "../lsp/service";
import type { Reporter } from "./events";
import { ruleHelpFromOutput } from "./rule-docs";

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
}

/** A required string arg, or "" if missing/wrong-type. */
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

/**
 * Parse a tool's args, with VALIDATE-THEN-REPAIR: try the tool's own parser; if
 * it rejects, apply the generic input repairs and try ONCE more. Emits telemetry
 * — `tool_input_repaired:<tool>` when a repair rescued the call,
 * `tool_input_rejected:<tool>` when even repair couldn't — so we can watch
 * per-tool failure rates as the toolset grows (right now rejections are
 * invisible: they're returned to the model but never logged).
 */
function parseOrRepair<T>(
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
function reject(ctx: IToolContext, tool: string, reason: string): string {
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_rejected:${tool} (${reason})`,
  });

  return reason;
}

/**
 * Perform one tool call and return the text result fed back to the model as a
 * tool message. `read`/`run` are unrestricted (read-only / sandboxed in the run
 * dir); `edit`/`create` are scope-enforced to the task's editable files.
 */
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

export async function executeTool(
  call: IToolCall,
  ctx: IToolContext
): Promise<string> {
  if (!isToolName(call.name)) {
    return `unknown tool: ${call.name}`;
  }

  return HANDLERS[call.name](call.arguments, ctx);
}

/** ripgrep search over the working dir — the model's primary navigation at
 *  scale (structural/text, fast). Falls back gracefully if `rg` is absent. */
async function doSearch(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const fromPattern = str(args, "pattern");
  const pattern = fromPattern.length > 0 ? fromPattern : str(args, "query");

  if (pattern.length === 0) {
    return "search: malformed args (need `pattern`)";
  }

  const glob = str(args, "glob");
  const globArg = glob.length > 0 ? ` -g ${JSON.stringify(glob)}` : "";
  const cmd = `rg --line-number --no-heading --color never -e ${JSON.stringify(pattern)}${globArg} || true`;
  const res = await runCommand(ctx.cwd, cmd);
  const out = `${res.stdout}${res.stderr}`.slice(0, LIMITS.maxToolOutputChars);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `search ${pattern}${glob.length > 0 ? ` (${glob})` : ""}`,
  });

  return out.trim().length > 0 ? out : `no matches for ${pattern}`;
}

/** Dispatch the semantic (LanguageService-backed) tools. The model addresses
 *  symbols by NAME + file; read-only tools are unrestricted, the two that WRITE
 *  (rename_symbol, organize_imports) are scope-enforced. */
function doLsp(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const svc = ctx.tsService;

  if (svc === undefined || svc === null) {
    return `${name}: unavailable (this project has no TypeScript LanguageService)`;
  }

  const file = fileArg(args) ?? "";
  const rel = (abs: string): string => relative(ctx.cwd, abs);

  if (name === TOOL_NAME.symbolSearch) {
    const q = str(args, "query");
    const query = q.length > 0 ? q : str(args, "symbol");

    if (query.length === 0) {
      return "symbol_search: need `query`";
    }

    const hits = svc.symbols(query);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `symbol_search ${query} → ${hits.length}`,
    });

    return hits.length === 0
      ? `no symbols matching '${query}'`
      : hits
          .map((h) => `${h.kind} ${h.name} — ${rel(h.file)}:${h.line}`)
          .join("\n");
  }

  if (name === TOOL_NAME.diagnostics) {
    if (file.length === 0) {
      return "diagnostics: need `file`";
    }

    const diags = svc.diagnostics(file);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `diagnostics ${file} → ${diags.length}`,
    });

    return diags.length === 0
      ? `no semantic diagnostics in ${file}`
      : diags
          .map((d) => `TS${d.code}: ${d.message.split("\n")[0] ?? d.message}`)
          .join("\n");
  }

  // The remaining tools address a symbol by name within a file.
  const symbol = str(args, "symbol");

  if (file.length === 0 || symbol.length === 0) {
    return `${name}: need {file, symbol}`;
  }

  const pos = svc.positionOfSymbol(file, symbol);

  if (pos === undefined) {
    return `${name}: '${symbol}' not found in ${file}`;
  }

  if (name === TOOL_NAME.typeAt) {
    const type = svc.typeAt(file, pos);

    ctx.report({ kind: "tool", task: ctx.task, message: `type_at ${symbol}` });

    return type.length > 0
      ? `${symbol}: ${type}`
      : `no type info for ${symbol}`;
  }

  if (name === TOOL_NAME.findReferences) {
    const refs = svc.references(file, pos);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `find_references ${symbol} → ${refs.length}`,
    });

    return refs.length === 0
      ? `no references to '${symbol}'`
      : refs.map((r) => `${rel(r.file)}:${r.line}`).join("\n");
  }

  if (name === TOOL_NAME.organizeImports) {
    if (!writable(file, ctx.files)) {
      return reject(
        ctx,
        "organize_imports",
        `organize_imports ${file} REJECTED: out of scope.`
      );
    }

    const n = svc.organizeImports(file);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `organize_imports ${file} (${n})`,
    });

    return `organize_imports: ${n} change(s) in ${file}`;
  }

  // rename_symbol — scope-enforced: a semantic rename can touch many files; it
  // must NOT edit read-only/out-of-scope ones.
  const newName = str(args, "newName");

  if (newName.length === 0) {
    return "rename_symbol: need `newName`";
  }

  const targets = svc.renameTargets(file, pos).map(rel);
  const outOfScope = targets.filter((t) => !writable(t, ctx.files));

  if (outOfScope.length > 0) {
    return reject(
      ctx,
      "rename_symbol",
      `rename '${symbol}' REJECTED: would edit out-of-scope/read-only file(s): ${outOfScope.join(", ")}. Rename only symbols whose every reference is in your editable files.`
    );
  }

  const changed = svc.rename(file, pos, newName);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `rename_symbol ${symbol}→${newName} (${changed ?? 0})`,
  });

  return changed === null
    ? `rename_symbol: '${symbol}' can't be renamed here`
    : `renamed '${symbol}' → '${newName}' across ${changed} location(s)`;
}

async function readFile(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = parseOrRepair(args, toRead, ctx, "read");

  if (r === null) {
    return "read: malformed args (need `file`)";
  }

  ctx.report({ kind: "tool", task: ctx.task, message: `read ${r.file}` });

  const handle = Bun.file(join(ctx.cwd, r.file));

  if (!(await handle.exists())) {
    return `read: ${r.file} does not exist`;
  }

  return handle.text();
}

async function runShell(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = parseOrRepair(args, toRun, ctx, "run");

  if (r === null) {
    return "run: malformed args (need `command`)";
  }

  const res = await runCommand(ctx.cwd, r.command);
  const output = `${res.stdout}${res.stderr}`.slice(
    0,
    LIMITS.maxToolOutputChars
  );

  // If the command surfaced lint/type errors, attach the failing rules' own
  // bad→good docs to what the model reads — so it fixes from examples, not blind.
  const help = res.exitCode === 0 ? "" : ruleHelpFromOutput(output);
  const guidance =
    help.length > 0 ? `\n\nFix guidance for the failing rules:\n${help}` : "";

  // Log the guidance too (in the event output) so we can SEE the injection fire,
  // not just feed it silently to the model.
  ctx.report({
    kind: "run",
    task: ctx.task,
    message: `$ ${r.command}`,
    command: r.command,
    exitCode: res.exitCode,
    output: `${output}${guidance}`,
  });

  return `exit ${res.exitCode}\n${output}${guidance}`;
}

async function doEdit(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const edit = parseOrRepair(args, toEdits, ctx, "edit");

  if (edit === null) {
    return "edit: malformed args (need `file` plus either `oldString`/`newString` or an `edits` array of {oldString,newString})";
  }

  if (!writable(edit.file, ctx.files)) {
    return reject(
      ctx,
      "edit",
      `edit ${edit.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
  }

  // The size cap is PER replacement — each piece must be surgical (no lazy
  // whole-function rewrite) — but a batch may carry many pieces, so the model
  // can fix the same issue at several spread-out sites in ONE turn.
  for (let i = 0; i < edit.edits.length; i += 1) {
    const span = (edit.edits[i]?.oldString ?? "").split("\n").length;

    if (span > LIMITS.maxEditLines) {
      return reject(
        ctx,
        "edit",
        `edit ${edit.file} REJECTED: replacement #${i + 1} is too large (${span} lines). Change ONLY the broken lines — make small, targeted replacements (the gate names the exact lines). To fix several spots, pass each as its own entry in \`edits\`; don't rewrite a whole function.`
      );
    }
  }

  const result = await applyEdits(ctx.cwd, edit.file, edit.edits);

  if (result.ok) {
    for (const r of edit.edits) {
      ctx.report({
        kind: "edit",
        task: ctx.task,
        file: edit.file,
        message: `edit ${edit.file}`,
        oldString: r.oldString,
        newString: r.newString,
      });
    }

    return `edited ${edit.file} (${result.count} change${result.count === 1 ? "" : "s"})`;
  }

  const where =
    edit.edits.length > 1 ? ` (replacement #${result.index + 1})` : "";
  const detail =
    result.reason === EDIT_FAIL_REASON.ambiguous
      ? `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`
      : result.reason;

  return reject(
    ctx,
    `edit:${result.reason}`,
    `edit ${edit.file} REJECTED${where}: ${detail}`
  );
}

async function doCreate(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const create = parseOrRepair(args, toCreate, ctx, "create");

  if (create === null) {
    return "create: malformed args (need file, content)";
  }

  if (!writable(create.file, ctx.files)) {
    return reject(
      ctx,
      "create",
      `create ${create.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
  }

  const result = await applyCreate(ctx.cwd, create);

  if (result.ok) {
    ctx.report({
      kind: "create",
      task: ctx.task,
      file: create.file,
      message: `create ${create.file}`,
      content: create.content,
    });

    return `created ${create.file}`;
  }

  return reject(
    ctx,
    "create:exists",
    `create ${create.file} REJECTED: already exists — use \`edit\``
  );
}
