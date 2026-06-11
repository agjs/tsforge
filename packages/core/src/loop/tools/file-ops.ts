import { join } from "node:path";
import { applyEdits } from "../../files/edit";
import { applyCreate } from "../../files/create";
import { EDIT_FAIL_REASON } from "../../files";
import { writable, normalizeWorkspacePath } from "../../lib/scope";
import { LOOP_LIMITS } from "../loop.constants";
import { toEdits, toCreate, toRun, toRead, runCommand } from "../../agent";
import { ruleHelpFromOutput } from "../feedback/rule-docs";
import { condenseToolOutput } from "./condense";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";

/**
 * Read a file for the model. TRUSTED-MODE (by design): `read` and `run` are NOT
 * sandboxed to the workspace — a `../config` read or any shell command the
 * process can run is permitted, like a local human-run coding agent (Claude Code,
 * etc.). Only WRITES (`edit`/`create`) are scope-enforced, since those are what
 * mutate the user's project. tsforge runs locally on the user's own machine
 * against their own code; the threat model is mistakes, not a hostile operator.
 * (Sandboxing reads would be a separate, explicit execution profile.)
 */
export async function readFile(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = parseOrRepair(args, toRead, ctx, "read");

  if (r === null) {
    return "read: malformed args (need `file`)";
  }

  r.file = normalizeWorkspacePath(ctx.cwd, r.file);

  ctx.report({ kind: "tool", task: ctx.task, message: `read ${r.file}` });

  const handle = Bun.file(join(ctx.cwd, r.file));

  if (!(await handle.exists())) {
    return `read: ${r.file} does not exist`;
  }

  return handle.text();
}

/** Commands a plan-mode `run` may execute — pure inspection, never mutation. */
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "find",
  "tree",
  "stat",
  "file",
  "which",
  "du",
  "tsc",
  "git",
]);

/** Git subcommands that only inspect the repo. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch"]);

/** Shell metacharacters that could turn a read into a write (`> out`, `&& rm`,
 *  `| tee`, command substitution). Their PRESENCE disqualifies — conservative. */
const SHELL_WRITE_RE = /[>;&|`]|\$\(/;

/**
 * Deterministically read-only: exactly one allowlisted command, no redirects/
 * pipes/chaining. Used by plan mode so the model can explore (`ls`, `rg`,
 * `git log`, `tsc --noEmit`) without any path to mutating the workspace.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (SHELL_WRITE_RE.test(command)) {
    return false;
  }

  const [head, sub] = command.trim().split(/\s+/);

  if (head === undefined || !READ_ONLY_COMMANDS.has(head)) {
    return false;
  }

  if (head === "git") {
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }

  return true;
}

export async function runShell(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = parseOrRepair(args, toRun, ctx, "run");

  if (r === null) {
    return "run: malformed args (need `command`)";
  }

  if (ctx.readOnly === true && !isReadOnlyCommand(r.command)) {
    return reject(
      ctx,
      "run",
      "plan mode: only read-only commands are allowed (ls, cat, rg, grep, find, " +
        `git status/log/diff/show/branch, tsc — no pipes/redirects). Blocked: ${r.command}`
    );
  }

  const res = await runCommand(
    ctx.cwd,
    r.command,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );
  const raw = `${res.stdout}${res.stderr}`;
  // Condition the output for the model through the single condensing pipeline
  // (progress-strip → shape/per-tool condensers → signal-preserving truncation).
  // Anything unrecognized — and any real FAILURE's errors — passes through.
  const { text: output, via } = condenseToolOutput(
    { command: r.command, output: raw, exitCode: res.exitCode },
    LOOP_LIMITS.maxToolOutputChars
  );

  // Make the saving observable (and let us SPOT over-condensing in the log).
  if (via !== null && output.length < raw.length) {
    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `condensed ${String(raw.length)}→${String(output.length)} chars via ${via}`,
    });
  }

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

  edit.file = normalizeWorkspacePath(ctx.cwd, edit.file);

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

  return reject(
    ctx,
    `edit:${result.reason}`,
    `edit ${edit.file} REJECTED${where}: ${editFailHelp(edit.file, result)}`
  );
}

/**
 * Turn an edit-failure reason into ACTIONABLE feedback. The bare reason strings
 * ("not-found", "missing-file") were fatally ambiguous: a slow local model read
 * an edit's "not-found" (= the oldString wasn't in the file) as "the FILE wasn't
 * found", switched to `create`, hit "already exists", and thrashed edit↔create to
 * the turn cap. Each message now says exactly what failed AND what to do next —
 * crucially, whether the file exists (don't `create`) or not (do `create`).
 */
function editFailHelp(
  file: string,
  result: { reason: string; matches?: number }
): string {
  if (result.reason === EDIT_FAIL_REASON.ambiguous) {
    return `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`;
  }

  if (result.reason === EDIT_FAIL_REASON.missingFile) {
    return `the file ${file} does not exist yet — use \`create\` to make it (NOT edit)`;
  }

  if (result.reason === EDIT_FAIL_REASON.notFound) {
    return `the file ${file} EXISTS, but your oldString text was not found in it. Do NOT use \`create\` (it already exists). \`read\` the file to see its exact current contents, then edit with text copied verbatim from it.`;
  }

  return result.reason;
}

export async function doCreate(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const create = parseOrRepair(args, toCreate, ctx, "create");

  if (create === null) {
    return "create: malformed args (need file, content)";
  }

  create.file = normalizeWorkspacePath(ctx.cwd, create.file);

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
