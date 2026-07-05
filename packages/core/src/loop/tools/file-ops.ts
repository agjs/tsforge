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
import { formatHashHeader, HL_LINE_SEP } from "../../files/hashline-format";
import { SessionSnapshotStore } from "../../files/hashline";
import { trace } from "../../lib/trace";

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

  ctx.snapshotStore ??= new SessionSnapshotStore();

  const hash = ctx.snapshotStore.record(r.file, content);
  const header = formatHashHeader(r.file, hash);
  const annotated = lines
    .map((line, i) => `${i + 1}${HL_LINE_SEP}${line}`)
    .join("\n");

  return `${header}\n${annotated}${note}`;
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

/** Path targets a shell command WRITES via `>`/`>>` redirect or `tee` — so the
 *  run tool can refuse a write that should go through `create`/`edit` (which the
 *  model bypasses by `cat > src/foo.tsx << EOF`, skipping the write-guard, the
 *  lint moat, and scope enforcement). Skips `>&`/`>(` (fd-dup / process subst). */
function shellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  // After `tee`, skip option tokens (`-a`, `--append`) so `tee -a src/foo.ts`
  // captures the FILE, not the flag (which would otherwise slip the write past
  // the guard since flag tokens are dropped below).
  const re =
    /(?:^|[\s|;&])(?:\d*>>?(?![&(])|tee\b(?:\s+-+\S+)*)\s*(['"]?)([^\s'"|;&<>()]+)\1/gu;
  let m: RegExpExecArray | null;

  while ((m = re.exec(command)) !== null) {
    const target = m[2];

    if (target !== undefined && !target.startsWith("-")) {
      targets.push(target);
    }
  }

  return targets;
}

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

/** Flags that make an otherwise read-only git subcommand WRITE a file to disk
 *  (`git diff --output=x`, `git diff -o x`). Matched as the exact token or its
 *  `=value` form, so `--output`, `--output=x`, and `-o` are all caught. */
const GIT_OUTPUT_FLAGS = new Set(["--output", "-o"]);

function isGitOutputFlag(arg: string): boolean {
  const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

  return GIT_OUTPUT_FLAGS.has(name);
}

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
  // Write a `.tsbuildinfo` to disk even alongside `--noEmit`, so a "read-only"
  // typecheck that carries them isn't read-only.
  "--tsBuildInfoFile",
  "--incremental",
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

  // diff/show/log inspect by default but can be redirected to a file via
  // `--output`/`-o` — that's a write, so disqualify it.
  return !rest.some(isGitOutputFlag);
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

/** Package managers whose `<dev|start|serve|…>` script starts a never-exiting
 *  process (`bun run dev`, `npm start`); `npx`/`bunx` instead delegate to a binary. */
const PKG_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn", "npx", "bunx"]);
/** Subcommand / script names that start a dev server or watcher (never exit). */
const SERVER_SUBCOMMANDS = new Set([
  "dev",
  "start",
  "serve",
  "preview",
  "watch",
]);
/** Binaries that ARE a server/watcher regardless of args — they take a file/dir/
 *  port positional, never an exiting subcommand. */
const ALWAYS_SERVER_BINARIES = new Set([
  "nodemon",
  "serve",
  "http-server",
  "live-server",
  "webpack-dev-server",
]);
/** Framework CLIs where a SERVER subcommand (`dev`/`serve`/…) means it never
 *  exits, but `build`/`generate`/`run` exit. */
const SUBCOMMAND_SERVER_BINARIES = new Set([
  "vite",
  "vitest",
  "next",
  "nuxt",
  "astro",
  "remix",
  "ng",
]);
/** Of those, the ones that start a server when run BARE (no subcommand) — `vite`
 *  defaults to the dev server, `vitest` to watch mode; `next`/`ng`/… just print
 *  help and exit. */
const BARE_SERVER_BINARIES = new Set(["vite", "vitest"]);

/** Command wrappers that delegate to the REAL command after them (and their own
 *  args), so the head must be taken from beyond them. */
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "env",
  "exec",
  "nohup",
  "setsid",
  "stdbuf",
  "nice",
  "time",
  "command",
]);

/** Strip wrapping quotes / a leading `(` subshell / trailing `)` from a token so
 *  `"npm"`, `'vite'`, `(npm` resolve to the bare command name. */
function unwrapToken(token: string): string {
  return token.replace(/^[("']+/u, "").replace(/[)"']+$/u, "");
}

/** Tokens of ONE shell segment, with quotes/parens stripped, env assignments
 *  dropped, and leading wrapper commands (`sudo`/`env`/`exec`/…) skipped. */
function segmentTokens(segment: string): string[] {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .map(unwrapToken)
    .filter((t) => t.length > 0 && !t.includes("="));
  let i = 0;

  while (i < tokens.length && COMMAND_WRAPPERS.has(tokens[i] ?? "")) {
    i += 1;
  }

  return tokens.slice(i);
}

/** A known server/watcher binary, judged by its first subcommand — `serve dist`
 *  (always), `vite`/`vite dev` (server), `vite build`/`next` (exits) → false. */
function binaryIsServer(base: string, sub: string | undefined): boolean {
  if (ALWAYS_SERVER_BINARIES.has(base)) {
    return true;
  }

  if (sub === undefined) {
    return BARE_SERVER_BINARIES.has(base);
  }

  return SUBCOMMAND_SERVER_BINARIES.has(base) && SERVER_SUBCOMMANDS.has(sub);
}

/** Language-runtime built-in servers: `php -S`, `python -m http.server`,
 *  `deno task <server>` / `deno run --watch`. */
function isRuntimeServer(base: string, rest: readonly string[]): boolean {
  if (base === "php") {
    return rest.includes("-S");
  }

  if (base === "python" || base === "python3") {
    return rest.includes("http.server");
  }

  if (base === "deno") {
    if (rest.includes("--watch")) {
      return true;
    }

    // `deno task <name>` — the name can sit behind flags (`deno task --cwd app dev`),
    // so match a server name ANYWHERE after `task`, not just at a fixed position.
    return (
      rest[0] === "task" && rest.slice(1).some((a) => SERVER_SUBCOMMANDS.has(a))
    );
  }

  return false;
}

/** A resolved command head + its args (no package-runner indirection): a watcher
 *  (`tsc --watch`, `tail -f`), a runtime server, or a server binary (`vite dev`). */
function headIsServer(base: string, rest: readonly string[]): boolean {
  if (base === "tail") {
    return rest.includes("-f") || rest.includes("-F");
  }

  if (base === "tsc") {
    return rest.includes("-w") || rest.includes("--watch");
  }

  if (isRuntimeServer(base, rest)) {
    return true;
  }

  return binaryIsServer(
    base,
    rest.find((a) => !a.startsWith("-"))
  );
}

/** Blank (→ single space) quoted spans that protect an argument — those containing
 *  whitespace or a shell separator (`;`/`|`/`&`). A quoted bare word (`'vite'`) is
 *  left as-is so a genuinely-quoted command name is still detected. */
function blankProtectedQuotes(command: string): string {
  const blank = (match: string, inner: string): string =>
    /[\s;|&]/u.test(inner) ? " " : match;

  return command.replace(/"([^"]*)"/gu, blank).replace(/'([^']*)'/gu, blank);
}

/** Is THIS single segment a foreground server/watcher? */
function segmentIsServer(segment: string): boolean {
  const tokens = segmentTokens(segment);
  const head = tokens[0];

  if (head === undefined) {
    return false;
  }

  const base = head.split("/").pop() ?? head;
  const rest = tokens.slice(1);

  if (PKG_RUNNERS.has(base)) {
    return pkgRunnerIsServer(rest);
  }

  return headIsServer(base, rest);
}

/** A `<pm> [run|exec|x] <script-or-binary> [args]` invocation — a server SCRIPT
 *  (`npm run dev`) or a DELEGATED binary, whose own flags must be re-checked so
 *  `npx tsc --watch` / `bunx tail -f` don't slip past (the flags were stripped to
 *  find the delegate). */
function pkgRunnerIsServer(rest: string[]): boolean {
  const args = rest.filter((a) => !a.startsWith("-"));
  const start =
    args[0] === "run" || args[0] === "exec" || args[0] === "x" ? 1 : 0;
  const first = args[start];

  if (first === undefined) {
    return false;
  }

  if (SERVER_SUBCOMMANDS.has(first)) {
    return true;
  }

  // Delegated binary (`npx <bin> …`): judge it by ITS OWN args, flags included.
  return headIsServer(first, rest.slice(rest.indexOf(first) + 1));
}

/**
 * A long-running dev server / watcher that never exits on its own (`vite`,
 * `bun run dev`, `next dev`, `tsc --watch`, `tail -f`, `php -S`, …). Running one in
 * the build loop stalls it — the gate already builds AND headlessly smoke-tests the
 * app, so the model never needs to. Checks EVERY segment of a chain (`cd app &&
 * npm run dev`), looks through wrappers (`exec`/`sudo`/quotes/subshell), and judges
 * package-runner delegates by their own flags. Best-effort: the run tool's
 * kill-timeout + bounded drain are the hard backstop for anything this misses. An
 * explicitly backgrounded whole command (`… &`, not `&&`) returns immediately, so it
 * is allowed through.
 */
export function isLongRunningServerCommand(command: string): boolean {
  // Blank out quoted spans that PROTECT an argument (they contain whitespace or a
  // shell separator) FIRST, so a `;`/`||`/binary-name inside a commit message or an
  // echo string can't cause a false split/match. A quoted bare word (`'vite'`,
  // `"npm"`) is left intact — `unwrapToken` resolves it to the real command.
  const unquoted = blankProtectedQuotes(command.trim()).trim();

  // A trailing single `&` (not `&&`) backgrounds the command — it returns at once.
  if (/(?:^|[^&])&$/u.test(unquoted)) {
    return false;
  }

  // A server anywhere in a `&&`/`||`/`;`/`|` chain stalls the loop just the same.
  return unquoted
    .split(/&&|\|\||[;|]/u)
    .some((segment) => segmentIsServer(segment));
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

  // Refuse a shell redirect/tee that WRITES an in-scope project file. The model
  // reaches for `cat > src/foo.tsx << EOF` to escape edit-tool friction, but that
  // bypasses the write-guard (no per-file type/lint feedback → errors pile to the
  // gate), the scope check, and hashline snapshots. Steer it back to create/edit —
  // `create` can now fully overwrite a file the model authored this session, so
  // this closes the hole WITHOUT trapping it. /tmp + out-of-scope targets are fine.
  const scopedWrite = shellWriteTargets(r.command).find((t) =>
    writable(normalizeWorkspacePath(ctx.cwd, t), ctx.files)
  );

  if (scopedWrite !== undefined) {
    return reject(
      ctx,
      "run:shell-write",
      `run ${r.command} REJECTED: writing a project file via a shell redirect (\`> ${scopedWrite}\`) bypasses the type/lint guard and scope checks. Use \`create\` to write or fully rewrite ${scopedWrite} (it overwrites a file you created this session), or \`edit\`/\`edit_lines\` for targeted changes — those get checked the instant you write.`
    );
  }

  if (isLongRunningServerCommand(r.command)) {
    return reject(
      ctx,
      "run",
      `"${r.command}" looks like a long-running dev server / watcher — it never ` +
        "exits, so it would stall the build loop. You do not need to run one: the " +
        "gate already builds the app and smoke-tests it in a headless browser. To " +
        "debug a blank page, read the build output and the component/source files; " +
        "page rendering is handled for you. (If you truly need a process running, " +
        "background it with a trailing `&` so the command returns.)"
    );
  }

  // Show WHAT is about to run BEFORE it runs (mirrors web_fetch/web_search) — a
  // long build/test otherwise looks frozen with no clue what's executing. The
  // command, exit code, and (condensed) output still follow in the `run` event.
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ run ${r.command}`,
  });

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
  const { value: edit, feedback } = parseOrRepair(args, toEdits, ctx, "edit");

  if (edit === null) {
    if (feedback !== undefined && feedback.length > 0) {
      return feedback;
    }

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
    // A no-op edit (same content / already applied) wrote nothing — report NO
    // mutation event so it can't trigger a re-gate or count toward "done", and
    // tell the model plainly so it doesn't think it made progress.
    if (!result.changed) {
      return `edit ${edit.file}: no change — the file already matches (oldString and newString are identical, or this edit was already applied). Move on to the next fix or run the gate.`;
    }

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

  const authored = ctx.touched?.has(edit.file.replaceAll("\\", "/")) ?? false;
  let help = editFailHelp(edit.file, result, authored);

  // A not-found edit is almost always a STALE ANCHOR — the auto-formatter rewrote
  // the file after the model's last write, so its oldString no longer matches. The
  // harness already has the current bytes, so inline them rather than make the
  // model spend a turn re-`read`ing (its #1 reported friction).
  if (result.reason === EDIT_FAIL_REASON.notFound) {
    const view = await currentFileView(ctx.cwd, edit.file);

    help +=
      view === null
        ? ` \`read\` ${edit.file} to see its exact current content, then edit with text copied verbatim.`
        : ` Its CURRENT content is below — copy oldString verbatim from it and retry (no need to \`read\`):\n\n${view}`;
  }

  return reject(
    ctx,
    `edit:${result.reason}`,
    `edit ${edit.file} REJECTED${where}: ${help}`
  );
}

/** Cap on lines inlined into a not-found edit rejection; above this, fall back to
 *  advising a `read` so a huge file can't flood the model's context. */
const EDIT_REJECT_MAX_LINES = 400;

/** The file's current content as numbered rows (line number + `HL_LINE_SEP` + text)
 *  — like `read`'s body but WITHOUT its hashline header (this repairs a `str_replace`
 *  edit, which anchors on verbatim text, not a line hash). Null if the file is
 *  missing, too large to inline, or unreadable. Used to repair a stale-anchor edit in
 *  the SAME turn — the model copies its oldString from the post-format text. Returns null on any I/O error (race, permissions): the edit has
 *  already failed, so enriching its message must never crash the tool — the caller
 *  then falls back to advising a `read`. */
async function currentFileView(
  cwd: string,
  file: string
): Promise<string | null> {
  try {
    const handle = Bun.file(join(cwd, file));

    if (!(await handle.exists())) {
      return null;
    }

    const lines = (await handle.text()).split("\n");

    if (lines.length > EDIT_REJECT_MAX_LINES) {
      return null;
    }

    return lines.map((line, i) => `${i + 1}${HL_LINE_SEP}${line}`).join("\n");
  } catch (err) {
    trace("tools.currentFileView", err);

    return null;
  }
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
  result: { reason: string; matches?: number },
  authored: boolean
): string {
  if (result.reason === EDIT_FAIL_REASON.ambiguous) {
    return `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`;
  }

  if (result.reason === EDIT_FAIL_REASON.missingFile) {
    return `the file ${file} does not exist yet — use \`create\` to make it (NOT edit)`;
  }

  if (result.reason === EDIT_FAIL_REASON.notFound) {
    // A file the model AUTHORED this session can be fully rewritten via `create`
    // (the overwrite escape hatch) — so when it's painted into a corner with stale
    // anchors or a too-large edit, offer that rather than steering it away from the
    // one clean exit (observed: ~20 turns thrashing edit↔read on its own service file).
    const rewrite = authored
      ? ` Since you created ${file} this session, you may also \`create\` it again to fully rewrite it.`
      : " Do NOT use `create` (it already exists).";

    return `the file ${file} EXISTS, but your oldString text was not found in it (it was likely auto-reformatted after your last write — imports reordered, quotes/commas normalized).${rewrite}`;
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

  if (!writable(create.file, ctx.files)) {
    return reject(
      ctx,
      "create",
      `create ${create.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
  }

  // A file the model AUTHORED this session (in the write-only change-set) may be
  // fully rewritten via `create` — it's the model's own work, already rewritable
  // via `edit`, so this grants no new power; it just provides the whole-file-rewrite
  // path the model otherwise lacks. Without it, a model that wrote a file badly (e.g.
  // seed data with `as` casts) thrashes edit(too-large)↔create(exists)↔edit_lines to
  // the turn cap. A file the model did NOT author (pre-existing/scaffold code) still
  // can't be clobbered by `create`.
  const authored = ctx.touched?.has(create.file.replaceAll("\\", "/")) ?? false;
  const result = await applyCreate(ctx.cwd, create, authored);

  if (result.ok) {
    const overwrote = authored;

    ctx.report({
      kind: "create",
      task: ctx.task,
      file: create.file,
      message: overwrote
        ? `create ${create.file} (overwrote your earlier version)`
        : `create ${create.file}`,
      content: create.content,
    });

    return overwrote
      ? `overwrote ${create.file} — full rewrite of the file you created earlier this session.`
      : `created ${create.file}`;
  }

  return reject(
    ctx,
    "create:exists",
    `create ${create.file} REJECTED: already exists and you didn't create it this session — use \`edit\` to change it.`
  );
}
