import { join } from "node:path";
import type { IToolCall } from "../inference/types";
import { applyEdits } from "../files/edit";
import { applyCreate } from "../files/create";
import { isInScope } from "../lib/scope";
import { toEdits, toCreate, toRun, toRead, runCommand } from "../agent/tools";
import { ruleHelpFromOutput } from "./rule-docs";
import type { Reporter } from "./events";

export interface IToolContext {
  cwd: string;
  /** Editable scope — `edit`/`create` outside it are rejected. */
  files: string[];
  report: Reporter;
  task: string;
}

const MAX_OUTPUT = 4000;
/** Reject an edit whose matched snippet spans more than this — a deterministic
 *  push toward surgical changes instead of rewriting whole functions/files
 *  (which is slow and reintroduces errors). The gate names the exact bad lines. */
const MAX_EDIT_LINES = 25;

/** A file the model may write: its editable scope, OR a throwaway `scratch/`
 *  experiment (ignored by the gate) so it can test hypotheses by running code
 *  instead of reasoning about it. */
function writable(file: string, files: string[]): boolean {
  return isInScope(file, files) || file.startsWith("scratch/");
}

/**
 * Perform one tool call and return the text result fed back to the model as a
 * tool message. `read`/`run` are unrestricted (read-only / sandboxed in the run
 * dir); `edit`/`create` are scope-enforced to the task's editable files.
 */
export async function executeTool(
  call: IToolCall,
  ctx: IToolContext
): Promise<string> {
  if (call.name === "read") {
    return readFile(call.arguments, ctx);
  }

  if (call.name === "run") {
    return runShell(call.arguments, ctx);
  }

  if (call.name === "edit") {
    return doEdit(call.arguments, ctx);
  }

  if (call.name === "create") {
    return doCreate(call.arguments, ctx);
  }

  return `unknown tool: ${call.name}`;
}

async function readFile(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = toRead(args);

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
  const r = toRun(args);

  if (r === null) {
    return "run: malformed args (need `command`)";
  }

  const res = await runCommand(ctx.cwd, r.command);
  const output = `${res.stdout}${res.stderr}`.slice(0, MAX_OUTPUT);

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
  const edit = toEdits(args);

  if (edit === null) {
    return "edit: malformed args (need `file` plus either `oldString`/`newString` or an `edits` array of {oldString,newString})";
  }

  if (!writable(edit.file, ctx.files)) {
    return `edit ${edit.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`;
  }

  // The size cap is PER replacement — each piece must be surgical (no lazy
  // whole-function rewrite) — but a batch may carry many pieces, so the model
  // can fix the same issue at several spread-out sites in ONE turn.
  for (let i = 0; i < edit.edits.length; i += 1) {
    const span = (edit.edits[i]?.oldString ?? "").split("\n").length;

    if (span > MAX_EDIT_LINES) {
      return `edit ${edit.file} REJECTED: replacement #${i + 1} is too large (${span} lines). Change ONLY the broken lines — make small, targeted replacements (the gate names the exact lines). To fix several spots, pass each as its own entry in \`edits\`; don't rewrite a whole function.`;
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
    result.reason === "ambiguous"
      ? `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`
      : result.reason;

  return `edit ${edit.file} REJECTED${where}: ${detail}`;
}

async function doCreate(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const create = toCreate(args);

  if (create === null) {
    return "create: malformed args (need file, content)";
  }

  if (!writable(create.file, ctx.files)) {
    return `create ${create.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`;
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

  return `create ${create.file} REJECTED: already exists — use \`edit\``;
}
