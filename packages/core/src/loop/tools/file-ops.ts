import { basename, join } from "node:path";
import { applyEdits } from "../../files/edit";
import { applyCreate } from "../../files/create";
import { EDIT_FAIL_REASON } from "../../files";
import { writable, normalizeWorkspacePath } from "../../lib/scope";
import { LOOP_LIMITS } from "../loop.constants";
import { toEdits, toCreate, toRun, toRead, runCommand } from "../../agent";
import { ruleHelpFromOutput } from "../feedback/rule-docs";
import { isRecord } from "../../lib/guards";
import { parseOrRepair, reject, type IToolContext } from "./tool-context";

/** Max DISTINCT (file × rule) groups to show when condensing ESLint JSON. */
const MAX_ESLINT_GROUPS = 25;
/** Max line numbers listed per group before eliding (the same rule on many lines). */
const MAX_GROUP_LINES = 15;

/** One (file × rule) group: the SAME rule firing on N lines collapses to one line. */
interface IEslintGroup {
  file: string;
  rule: string;
  message: string;
  severe: boolean;
  lines: number[];
}

interface IEslintTally {
  errors: number;
  warnings: number;
  /** Keyed by `${file}|${rule}` so a repeated rule aggregates instead of repeating. */
  groups: Map<string, IEslintGroup>;
}

/** Tally one ESLint message into `acc`, grouping by file+rule. */
function tallyEslintMessage(
  filePath: string,
  message: unknown,
  acc: IEslintTally
): void {
  if (!isRecord(message)) {
    return;
  }

  const severe = message.severity === 2;

  acc.errors += severe ? 1 : 0;
  acc.warnings += severe ? 0 : 1;

  const file = basename(filePath);
  const rule = typeof message.ruleId === "string" ? message.ruleId : "?";
  const text = typeof message.message === "string" ? message.message : "";
  const line = typeof message.line === "number" ? message.line : 0;
  const key = `${file}|${rule}`;
  const existing = acc.groups.get(key);

  if (existing === undefined) {
    acc.groups.set(key, { file, rule, message: text, severe, lines: [line] });

    return;
  }

  existing.lines.push(line);
}

/** Render one group: a single occurrence stays `file:line msg (rule)`; many
 *  occurrences of the same rule collapse to `file msg (rule) — L1,L2,… (×N)`. */
function renderEslintGroup(g: IEslintGroup): string {
  const tag = g.severe ? "" : " [warn]";

  if (g.lines.length === 1) {
    return `  ${g.file}:${String(g.lines[0])} ${g.message} (${g.rule})${tag}`;
  }

  const shown = g.lines.slice(0, MAX_GROUP_LINES).map(String).join(",");
  const elided = g.lines.length > MAX_GROUP_LINES ? ",…" : "";

  return `  ${g.file} ${g.message} (${g.rule})${tag} — L${shown}${elided} (×${String(g.lines.length)})`;
}

/**
 * ESLint `--format json` dumps a full object PER FILE — for a 30-file app that's
 * ~30 verbose blobs of "errorCount: 0" noise that pollute the conversation (and at
 * a slow local model, re-reading it every turn is real wasted time). When the model
 * runs eslint, collapse it to a summary: "0 problems ✓", or the problems GROUPED by
 * file+rule (so the same rule on 9 lines is one line, not nine). Returns null if the
 * output isn't ESLint JSON (so other commands pass through untouched). The GATE
 * parses raw JSON elsewhere; this only affects what the MODEL reads from `run`.
 */
function condenseEslintJson(output: string): string | null {
  if (!output.includes('"filePath"') || !output.includes('"messages"')) {
    return null;
  }

  // Locate the JSON array even if eslint printed a deprecation warning or the
  // command was echoed before it (a leading prefix is why a strict startsWith
  // check missed it). Slice from the first "[" to the last "]".
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");

  if (start < 0 || end <= start) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const acc: IEslintTally = { errors: 0, warnings: 0, groups: new Map() };

  for (const entry of parsed) {
    if (!isRecord(entry) || !Array.isArray(entry.messages)) {
      return null; // not the ESLint shape — don't risk mangling it
    }

    const filePath = typeof entry.filePath === "string" ? entry.filePath : "?";

    for (const message of entry.messages) {
      tallyEslintMessage(filePath, message, acc);
    }
  }

  if (acc.errors === 0 && acc.warnings === 0) {
    return `eslint: ${String(parsed.length)} files checked, 0 problems ✓`;
  }

  const groups = [...acc.groups.values()];
  const shownGroups = groups.slice(0, MAX_ESLINT_GROUPS);
  const body = shownGroups.map(renderEslintGroup).join("\n");
  const more =
    groups.length > shownGroups.length
      ? `\n  …and ${String(groups.length - shownGroups.length)} more rule/file group(s)`
      : "";

  return (
    `eslint: ${String(acc.errors)} error(s), ${String(acc.warnings)} warning(s) in ` +
    `${String(parsed.length)} files:\n${body}${more}`
  );
}

/**
 * `vite build` prints a 20+ row chunk table (every `dist/assets/*.js` with raw +
 * gzip sizes) — pure noise the model never acts on, re-read every turn at a slow
 * local model. On a SUCCESSFUL build collapse it to one line. Returns null when it
 * isn't a vite-build success (errors pass through verbatim — the model must see
 * those). The model is told not to self-run the gate, but it does; this is the net.
 */
function condenseViteBuild(output: string): string | null {
  const built = /built in ([\d.]+\s*m?s)/.exec(output);

  // Only condense a clean success: "✓ N modules transformed" + "built in …" and no
  // build error. Anything else (a real failure) must reach the model untouched.
  if (built === null || !output.includes("modules transformed")) {
    return null;
  }

  if (/error|Could not resolve|failed|✗/i.test(output)) {
    return null;
  }

  const modules = /(\d+)\s+modules transformed/.exec(output);
  const chunks = (output.match(/dist\/assets\//g) ?? []).length;

  return (
    `vite build ✓ — ${modules?.[1] ?? "?"} modules, ${String(chunks)} chunks, ` +
    `built in ${built[1] ?? "?"} (chunk table elided)`
  );
}

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

export async function runShell(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const r = parseOrRepair(args, toRun, ctx, "run");

  if (r === null) {
    return "run: malformed args (need `command`)";
  }

  const res = await runCommand(
    ctx.cwd,
    r.command,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );
  const raw = `${res.stdout}${res.stderr}`;
  // Condense high-noise self-run output the model never acts on: verbose ESLint
  // JSON (per-file "0 problems" blobs, repeated-rule lists) and the vite-build
  // chunk table. Each condenser returns null when the output isn't its shape, so
  // everything else — and any real FAILURE — passes through verbatim.
  const condensed = condenseEslintJson(raw) ?? condenseViteBuild(raw) ?? raw;
  const output = condensed.slice(0, LOOP_LIMITS.maxToolOutputChars);

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
