import { join, relative } from "node:path";
import { rm } from "node:fs/promises";
import { applyEdits } from "../../files/edit";
import type { EditsResult } from "../../files/files.types";
import { applyCreate } from "../../files/create";
import { EDIT_FAIL_REASON } from "../../files";
import {
  isPathUnderRoot,
  OUTSIDE_PROJECT_REJECT,
  outsideWorkspacePaths,
  resolveProjectPath,
} from "../../lib/scope";
import { LOOP_LIMITS } from "../loop.constants";
import {
  toEdits,
  toCreate,
  toRun,
  toRead,
  runCommand,
  diagnoseCreateArgs,
  diagnoseEditArgs,
} from "../../agent";
import { peelNestedToolArgs } from "../../agent/tool-repair";
import { ruleHelpFromOutput } from "../feedback/rule-docs";
import { condenseToolOutput } from "./condense";
import {
  looksLikeHarnessOmitMarker,
  hasHarnessOmittedArgs,
} from "../context-hygiene";
import {
  parseOrRepair,
  reject,
  guardVeto,
  type IToolContext,
  resolveWritable,
} from "./tool-context";
import { formatHashHeader, HL_LINE_SEP } from "../../files/hashline-format";
import { SessionSnapshotStore } from "../../files/hashline";
import { trace } from "../../lib/trace";

/** Refuse writes that paste harness history markers onto disk (seen live). */
const HARNESS_MARKER_REJECT =
  "that string is a harness history marker, NOT source code. " +
  "`read` the file and pass real contents to create/edit.";

/** Refuse re-submitting history stubs as tool args (contentMeta / _harness…). */
const HARNESS_META_ARGS_REJECT =
  "create/edit REJECTED: those args are a harness history stub, not a valid " +
  "write. Pass real `content` (create) or `oldString`/`newString` (edit).";

/**
 * Read a file for the model. Confined to session cwd (+ optional `extraRoots`):
 * foreign absolute trees (e.g. a leaked harness install path) are rejected.
 * Writes (`edit`/`create`) remain separately scope-enforced via editable globs.
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

  const roots = ctx.extraRoots ?? [];
  const resolved = resolveProjectPath(ctx.cwd, r.file, roots);

  if (!resolved.ok) {
    return reject(ctx, "read", `REJECTED: ${OUTSIDE_PROJECT_REJECT}`);
  }

  // Snapshot / hashline keys stay cwd-relative when possible; extraRoots may sit
  // outside cwd, so fall back to the absolute path for the key/display.
  r.file = isPathUnderRoot(ctx.cwd, resolved.abs)
    ? relative(ctx.cwd, resolved.abs)
    : resolved.abs;

  ctx.report({ kind: "tool", task: ctx.task, message: `read ${r.file}` });

  const handle = Bun.file(resolved.abs);

  if (!(await handle.exists())) {
    return `read: ${r.file} does not exist`;
  }

  // First-time reads this send pause the readonly-spin streak (orientation).
  (ctx.surveyed ??= new Set()).add(r.file.replaceAll("\\", "/"));

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
  "pwd",
  "tsc",
  "git",
]);

/** Runtimes whose `--version` / `-v` is a pure info probe (greenfield plan mode). */
const VERSION_PROBE_BINS = new Set(["node", "bun", "npm", "pnpm", "yarn"]);

/** Git subcommands that only inspect the repo. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch"]);

/**
 * Shell metacharacters that make a command non-inspectable for plan mode.
 * Allows `&&` chains of read-only segments (greenfield: `pwd && ls`); still
 * rejects pipes, redirects, `;`, background `&`, and command substitution.
 */
function hasDisallowedShellMeta(command: string): boolean {
  if (/[>|`]|\$\(|;/.test(command)) {
    return true;
  }

  // Trailing or lone `&` (background) — not `&&`.
  return /(?:^|[^&])&(?:[^&]|$)/u.test(command);
}

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
 * Deterministically read-only: allowlisted inspection commands with no
 * redirects/pipes/backgrounding. `&&` chains are OK when EVERY segment is
 * independently read-only (`pwd && ls`, `node --version && bun --version`) —
 * a trailing `rm` still fails. Used by plan mode so greenfield can probe the
 * environment without a path to mutating the workspace.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (hasDisallowedShellMeta(command)) {
    return false;
  }

  const segments = command
    .split(/\s*&&\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return segments.length > 0 && segments.every(isReadOnlySegment);
}

/** One `&&`-free segment: allowlisted head, or a runtime `--version`/`-v` probe. */
function isReadOnlySegment(segment: string): boolean {
  const [head, ...rest] = segment.trim().split(/\s+/);

  if (head === undefined) {
    return false;
  }

  if (VERSION_PROBE_BINS.has(head)) {
    return rest.length === 1 && (rest[0] === "--version" || rest[0] === "-v");
  }

  if (!READ_ONLY_COMMANDS.has(head)) {
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
      "plan mode: only read-only commands are allowed (ls, cat, rg, pwd, " +
        "node/bun/npm --version, git status/log/diff, tsc --noEmit — no pipes/" +
        `redirects; \`&&\` OK if every segment is read-only). Blocked: ${r.command}`
    );
  }

  const foreign = outsideWorkspacePaths(
    ctx.cwd,
    r.command,
    ctx.extraRoots ?? []
  );

  if (foreign.length > 0) {
    return reject(
      ctx,
      "run",
      `REJECTED: ${OUTSIDE_PROJECT_REJECT} (paths: ${foreign.join(", ")})`
    );
  }

  // Refuse a shell redirect/tee that WRITES an in-scope project file. The model
  // reaches for `cat > src/foo.tsx << EOF` to escape edit-tool friction, but that
  // bypasses the write-guard (no per-file type/lint feedback → errors pile to the
  // gate), the scope check, and hashline snapshots. Steer it back to create/edit —
  // `create` can now fully overwrite a file the model authored this session, so
  // this closes the hole WITHOUT trapping it. /tmp + out-of-scope targets are fine.
  // Resolved through resolveWritable so the target is normalized first, exactly as
  // the edit tools do it.
  const scopedWrite = shellWriteTargets(r.command)
    .map((target) => resolveWritable(ctx, target))
    .find((resolved) => resolved.writable);

  if (scopedWrite !== undefined) {
    return reject(
      ctx,
      "run:shell-write",
      `run REJECTED: do not write project files via shell redirect ` +
        `(\`> ${scopedWrite.path}\`). Use \`create\` or \`edit\`/\`edit_lines\` instead.`
    );
  }

  if (isLongRunningServerCommand(r.command)) {
    return reject(
      ctx,
      "run",
      `"${r.command}" looks like a long-running server/watcher and would hang. ` +
        "Skip it — the gate already builds and smoke-tests. To keep a process, " +
        "background with a trailing `&`."
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

/**
 * True when `content` has a SYNTAX/parse error — it won't parse at all. Used ONLY
 * to decide whether `create` may overwrite an existing file: a parseable file is
 * protected (a wholesale `create` over the SHARED app schema would wipe other
 * resources' tables — unrecoverable), so the model rewrites it via the now-uncapped
 * `edit`; an unparseable file has nothing worth protecting and `create` may replace
 * it wholesale. Bun's transpiler throws on parse errors but NOT type errors, so a
 * merely type-wrong file stays protected.
 *
 * Empty / whitespace-only is treated as broken too: there is nothing to protect,
 * and `edit` cannot recover (empty `oldString` is rejected). Dogfood: a wiped
 * `index.css` hit `create:exists` + `edit:not-found` forever while the file was
 * 0 bytes.
 */
function isSyntacticallyBroken(content: string, file: string): boolean {
  if (content.trim().length === 0) {
    return true;
  }

  // JSON must be parsed as JSON, NOT transpiled as JS: a valid JSON object
  // (`{ "features": {…} }`) is a block statement to the JS transpiler and would
  // be misread as "broken", letting `create` overwrite (and gut) a valid locale
  // file. Parse it properly so a valid .json file is protected.
  if (file.endsWith(".json")) {
    try {
      JSON.parse(content);

      return false;
    } catch {
      return true;
    }
  }

  const loader = file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".jsx")
      ? "jsx"
      : file.endsWith(".ts")
        ? "ts"
        : "js";

  try {
    new Bun.Transpiler({ loader }).transformSync(content);

    return false;
  } catch {
    return true;
  }
}

function rejectEditHarnessMarkers(
  edits: readonly { readonly oldString: string; readonly newString: string }[],
  ctx: IToolContext
): string | null {
  for (const part of edits) {
    if (
      looksLikeHarnessOmitMarker(part.oldString) ||
      looksLikeHarnessOmitMarker(part.newString)
    ) {
      return reject(ctx, "edit:harness-marker", HARNESS_MARKER_REJECT);
    }
  }

  return null;
}

export async function doEdit(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  // Peel nested `{ arguments: {…} }` BEFORE history-meta — DeepSeek re-submits
  // stubs wrapped in another arguments bag; checking only the outer object
  // missed the omit flag (Ledgerkit: 43× L3 on {_harnessArgsOmitted,file}).
  const peeled = peelNestedToolArgs(args);

  // True stub re-submit (omit flag / legacy *Meta) — not file-only incompletes
  // (those get L3 diagnose). Reservely: file-only→history-meta thrashed forever.
  if (hasHarnessOmittedArgs(peeled)) {
    return reject(ctx, "edit:history-meta", HARNESS_META_ARGS_REJECT);
  }

  const { value: edit, feedback } = parseOrRepair(
    args,
    toEdits,
    ctx,
    "edit",
    diagnoseEditArgs
  );

  if (edit === null) {
    return (
      feedback ??
      "edit: malformed args (need `file` plus either `oldString`/`newString` or an `edits` array of {oldString,newString})"
    );
  }

  const markerReject = rejectEditHarnessMarkers(edit.edits, ctx);

  if (markerReject !== null) {
    return markerReject;
  }

  const editTarget = resolveWritable(ctx, edit.file);

  edit.file = editTarget.path;

  if (!editTarget.writable) {
    return reject(
      ctx,
      "edit",
      `edit ${edit.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
  }

  // No edit-size policing. Forcing "small, targeted" edits is a documented
  // dead-end: when the fix genuinely needs a large replacement the model thrashes
  // — failing edits, trying `create`, reaching for `rm`/redirect — instead of just
  // making the change (observed live, ~30 min on one resource). The only hard rule
  // is that each `oldString` matches a UNIQUE region, which `applyEdits` enforces;
  // edit SIZE is the model's call, guided softly by the tool description (like pi's
  // edit/write split). The gate is the sole arbiter of correctness.
  // A registered edit guard may VETO an edit (e.g. a stack overlay that forbids a
  // destructive change): capture the pre-edit bytes, let the edit apply, then let
  // the guard inspect before/after and, on veto, revert + return its rejection.
  const guardBefore =
    ctx.editGuard === undefined
      ? null
      : await readFileTextOrNull(join(ctx.cwd, edit.file));

  const result = await applyEdits(ctx.cwd, edit.file, edit.edits);

  const veto = await runEditGuard(ctx, edit.file, guardBefore, result);

  if (veto !== null) {
    return veto;
  }

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

  let help = editFailHelp(edit.file, result);

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

/** Run the registered edit guard (if any) against a just-applied edit. On veto,
 *  reverts the file to `before` and returns the model-facing rejection; otherwise
 *  null. No-op when no guard is set, the edit failed/no-op'd, or `before` is
 *  unavailable. */
async function runEditGuard(
  ctx: IToolContext,
  file: string,
  before: string | null,
  result: EditsResult
): Promise<string | null> {
  if (
    ctx.editGuard === undefined ||
    before === null ||
    !result.ok ||
    !result.changed
  ) {
    return null;
  }

  const after = await readFileTextOrNull(join(ctx.cwd, file));
  const veto = after === null ? null : guardVeto(ctx, file, before, after);

  if (veto === null) {
    return null;
  }

  await Bun.write(join(ctx.cwd, file), before);

  return reject(ctx, `edit:${veto.reason}`, veto.message);
}

/** Read a file's text, or null if it doesn't exist / can't be read. Used to diff
 *  a file's bytes before/after an edit for a registered edit guard. */
async function readFileTextOrNull(path: string): Promise<string | null> {
  try {
    const handle = Bun.file(path);

    if (!(await handle.exists())) {
      return null;
    }

    return await handle.text();
  } catch (err) {
    trace("tools.readFileTextOrNull", err);

    return null;
  }
}

/** The file's current content as numbered rows (line number + `HL_LINE_SEP` + text)
 *  — like `read`'s body but WITHOUT its hashline header (this repairs a `str_replace`
 *  edit, which anchors on verbatim text, not a line hash). Null if the file is
 *  missing, too large to inline, or unreadable. Used to repair a stale-anchor edit in
 *  the SAME turn — the model copies its oldString from the post-format text. Returns
 *  null on any I/O error (race, permissions): the edit has already failed, so
 *  enriching its message must never crash the tool — the caller then advises a `read`. */
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
  result: { reason: string; matches?: number }
): string {
  if (result.reason === EDIT_FAIL_REASON.ambiguous) {
    return `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`;
  }

  if (result.reason === EDIT_FAIL_REASON.missingFile) {
    return `the file ${file} does not exist yet — use \`create\` to make it (NOT edit)`;
  }

  if (result.reason === EDIT_FAIL_REASON.notFound) {
    // Stale anchor — CURRENT content is inlined by the caller; keep the
    // EXISTS / Do NOT recreate phrases (execute-tool tests lock them).
    return (
      `the file ${file} EXISTS, but your oldString was not found in it. ` +
      `Do NOT recreate or rewrite the file — copy a fresh oldString from its ` +
      `CURRENT content and make a targeted \`edit\`.`
    );
  }

  return result.reason;
}

export async function doCreate(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  // Peel nested envelopes before history-meta (same Ledgerkit bypass as edit).
  const peeled = peelNestedToolArgs(args);

  // True stub / legacy meta only — file-only incompletes fall through to L3.
  if (hasHarnessOmittedArgs(peeled)) {
    return reject(ctx, "create:history-meta", HARNESS_META_ARGS_REJECT);
  }

  const { value: create, feedback } = parseOrRepair(
    args,
    toCreate,
    ctx,
    "create",
    diagnoseCreateArgs
  );

  if (create === null) {
    return feedback ?? "create: malformed args (need file, content)";
  }

  if (looksLikeHarnessOmitMarker(create.content)) {
    return reject(ctx, "create:harness-marker", HARNESS_MARKER_REJECT);
  }

  const createTarget = resolveWritable(ctx, create.file);

  create.file = createTarget.path;

  if (!createTarget.writable) {
    return reject(
      ctx,
      "create",
      `create ${create.file} REJECTED: out of scope. You may only edit/create: ${ctx.files.join(", ")} (or throwaway files under scratch/).`
    );
  }

  // `create` refuses to overwrite an existing file that still PARSES. This is NOT
  // an edit-size trap (that cap is gone — `edit` now takes any-size replacements,
  // so a full rewrite goes through `edit`): it protects SHARED working files. The
  // model is scoped to the shared app schema (all resources' tables); a wholesale
  // `create` there would silently wipe every OTHER resource's table — unrecoverable.
  // Exceptions: a file that no longer parses, or an empty/whitespace-only file —
  // nothing worth protecting, and surgical `edit` can't recover an empty file
  // (empty oldString is otherwise rejected). Overwrite is the clean fix.
  const createPath = join(ctx.cwd, create.file);
  const exists = await Bun.file(createPath).exists();
  const before = exists
    ? await Bun.file(createPath)
        .text()
        .catch(() => "")
    : "";

  if (exists && !isSyntacticallyBroken(before, create.file)) {
    return reject(
      ctx,
      "create:exists",
      `create ${create.file} REJECTED: file already exists. Use \`edit\` to change it (full-file rewrite is fine).`
    );
  }

  const result = await applyCreate(ctx.cwd, create, exists);

  if (result.ok) {
    // Run the edit guard on the create too — NOT as overwrite protection (a valid
    // file is already refused above), but so a guard with per-build state SEES the
    // keys this create writes (e.g. the boringstack i18n guard records them as
    // session-authored, closing the create→gut bypass). A veto reverts the write.
    const veto = guardVeto(ctx, create.file, before, create.content);

    if (veto !== null) {
      await (exists
        ? Bun.write(createPath, before)
        : rm(createPath, { force: true }));

      return reject(ctx, `create:${veto.reason}`, veto.message);
    }

    ctx.report({
      kind: "create",
      task: ctx.task,
      file: create.file,
      message: exists
        ? `create ${create.file} (rewrote an empty or syntactically-broken file)`
        : `create ${create.file}`,
      content: create.content,
    });

    return exists
      ? `created ${create.file} — rewrote a previously empty or broken file.`
      : `created ${create.file}`;
  }

  return reject(
    ctx,
    "create",
    `create ${create.file} could not be written (${result.reason}).`
  );
}
