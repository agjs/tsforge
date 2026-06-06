import { join } from "node:path";
import { applyEdits } from "../files/edit";
import { applyCreate } from "../files/create";
import { EDIT_FAIL_REASON } from "../files";
import { writable } from "../lib/scope";
import { LOOP_LIMITS } from "./loop.constants";
import { toEdits, toCreate, toRun, toRead, runCommand } from "../agent";
import { ruleHelpFromOutput } from "./rule-docs";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";

export async function readFile(
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

export async function runShell(
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
    LOOP_LIMITS.maxToolOutputChars
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

export async function doEdit(
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

    if (span > LOOP_LIMITS.maxEditLines) {
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

export async function doCreate(
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
