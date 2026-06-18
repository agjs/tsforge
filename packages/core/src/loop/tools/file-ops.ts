import { join } from "node:path";
import { applyEdits } from "../../files/edit";
import { applyCreate } from "../../files/create";
import { EDIT_FAIL_REASON } from "../../files";
import { writable, normalizeWorkspacePath, isVendored } from "../../lib/scope";
import { LOOP_LIMITS } from "../loop.constants";
import { toEdits, toCreate, toRun, toRead, runCommand } from "../../agent";
import { ruleHelpFromOutput } from "../feedback/rule-docs";
import { condenseToolOutput } from "./condense";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";
import { formatHashHeader, HL_LINE_SEP } from "../../files/hashline-format";
import { SessionSnapshotStore } from "../../files/hashline";
import { flags } from "../../config";

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
  ctx: IToolContext & { snapshotStore?: SessionSnapshotStore }
): Promise<string> {
  const { value: r, feedback } = parseOrRepair(args, toRead, ctx, "read");

  if (r === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

    return "read: malformed args (need `file`)";
  }

  r.file = normalizeWorkspacePath(ctx.cwd, r.file);

  ctx.report({ kind: "tool", task: ctx.task, message: `read ${r.file}` });

  const handle = Bun.file(join(ctx.cwd, r.file));

  if (!(await handle.exists())) {
    return `read: ${r.file} does not exist`;
  }

  const content = await handle.text();
  const allLines = content.split("\n");
  // Cap the DISPLAYED output so a huge file can't flood the model's context. The
  // hashline snapshot below still records the FULL content, so range edits beyond
  // the cap keep working; only the rendered view is bounded.
  const truncated = allLines.length > MAX_READ_LINES;
  const lines = truncated ? allLines.slice(0, MAX_READ_LINES) : allLines;
  const note = truncated
    ? `\n\n… [truncated: ${MAX_READ_LINES} of ${allLines.length} lines shown. ` +
      `Read a specific range or search with \`run\` — e.g. ` +
      `\`sed -n '${MAX_READ_LINES + 1},${MAX_READ_LINES + 200}p' ${r.file}\` ` +
      `or \`rg <pattern> ${r.file}\`.]`
    : "";

  // Annotate with hashline header if enabled
  if (flags.hashlineEditTool()) {
    ctx.snapshotStore ??= new SessionSnapshotStore();

    const hash = ctx.snapshotStore.record(r.file, content);
    const header = formatHashHeader(r.file, hash);
    const annotated = lines
      .map((line, i) => `${i + 1}${HL_LINE_SEP}${line}`)
      .join("\n");

    return `${header}\n${annotated}${note}`;
  }

  return `${lines.join("\n")}${note}`;
}

/** Cap on the lines a single `read` renders — a huge file would otherwise wall
 *  the model's context. The full content is still snapshotted for hashline edits. */
const MAX_READ_LINES = 1500;

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

/** `find` actions that mutate or execute, not just match (`find . -delete`,
 *  `-exec rm {} +`). Allowlisting `find` without this let plan mode delete files. */
const FIND_MUTATING = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** `git branch` flags that delete/rename/copy a branch. A bare positional
 *  (`git branch foo`) also CREATES a branch, so any non-flag arg disqualifies. */
const GIT_BRANCH_MUTATING = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--edit-description",
]);

/** `tsc` flags that EMIT files to disk (the rest of a `--noEmit` typecheck is
 *  read-only). Bare `tsc`/`tsc -p x` also emit, so a read-only run must say so. */
const TSC_EMITTING = new Set([
  "--outDir",
  "--outFile",
  "--out",
  "-d",
  "--declaration",
  "--emitDeclarationOnly",
  "--build",
  "-b",
]);

/** `tsc` invocations that don't touch disk even without `--noEmit`. */
const TSC_INFO_FLAGS = new Set([
  "--version",
  "-v",
  "--help",
  "-h",
  "--showConfig",
  "--listFilesOnly",
]);

function gitIsReadOnly(sub: string | undefined, rest: string[]): boolean {
  if (sub === undefined || !READ_ONLY_GIT.has(sub)) {
    return false;
  }

  if (sub === "branch") {
    // Only listing is read-only: reject delete/rename/force flags AND any
    // positional (which would create/rename a branch).
    return !rest.some((a) => GIT_BRANCH_MUTATING.has(a) || !a.startsWith("-"));
  }

  return true;
}

function tscIsReadOnly(rest: string[]): boolean {
  if (rest.some((a) => TSC_EMITTING.has(a))) {
    return false;
  }

  // Emits by default — a read-only run must pass --noEmit (or be an info query).
  return rest.includes("--noEmit") || rest.some((a) => TSC_INFO_FLAGS.has(a));
}

/**
 * Deterministically read-only: exactly one allowlisted command with no
 * redirects/pipes/chaining AND no MUTATING FLAGS for that command. Used by plan
 * mode so the model can explore (`ls`, `rg`, `git log`, `tsc --noEmit`) with no
 * path to mutating the workspace — an allowlisted command can still write via a
 * flag (`find . -delete`, `git branch -D`, `tsc --outDir`), so each is checked.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (SHELL_WRITE_RE.test(command)) {
    return false;
  }

  const [head, ...rest] = command.trim().split(/\s+/);

  if (head === undefined || !READ_ONLY_COMMANDS.has(head)) {
    return false;
  }

  if (head === "git") {
    return gitIsReadOnly(rest[0], rest.slice(1));
  }

  if (head === "find") {
    return !rest.some((a) => FIND_MUTATING.has(a));
  }

  if (head === "tsc") {
    return tscIsReadOnly(rest);
  }

  return true;
}

export async function runShell(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const { value: r, feedback } = parseOrRepair(args, toRun, ctx, "run");

  if (r === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

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

/**
 * The rejection shown when the model tries to write a VENDORED file. These are
 * tested, already-type-correct harness files (the SDK in `src/lib/`, the UI
 * primitives in `src/components/ui/`, the MSW machinery, `*.gen.ts`). The whole
 * point is to break the loop where a model "fixes" generic SDK types it can never
 * satisfy: the message redirects it to its own call site.
 */
function vendoredRejectMessage(op: "edit" | "create", file: string): string {
  return `${op} ${file} REJECTED: this is a VENDORED, already-type-correct harness file you must NOT modify. A type error involving it means the bug is at YOUR CALL SITE — fix how you USE it (the types/args you pass), not the file itself.`;
}

export async function doEdit(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const { value: edit, feedback } = parseOrRepair(args, toEdits, ctx, "edit");

  if (edit === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

    return "edit: malformed args (need `file` plus either `oldString`/`newString` or an `edits` array of {oldString,newString})";
  }

  edit.file = normalizeWorkspacePath(ctx.cwd, edit.file);

  if (isVendored(edit.file, ctx.vendored ?? [])) {
    return reject(
      ctx,
      "edit:vendored",
      vendoredRejectMessage("edit", edit.file)
    );
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
  const { value: create, feedback } = parseOrRepair(
    args,
    toCreate,
    ctx,
    "create"
  );

  if (create === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

    return "create: malformed args (need file, content)";
  }

  create.file = normalizeWorkspacePath(ctx.cwd, create.file);

  if (isVendored(create.file, ctx.vendored ?? [])) {
    return reject(
      ctx,
      "create:vendored",
      vendoredRejectMessage("create", create.file)
    );
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
