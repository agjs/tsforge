#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { runTask, RUN_STATUS, Session } from "./loop";
import {
  PROVIDER_LIMITS,
  OpenAICompatibleProvider,
  PROVIDER_DEFAULTS,
  type IProvider,
} from "./inference";
import { renderEvent, renderMessage, welcomeBanner } from "./render";
import type { ITask } from "./spec";
import type { Reporter } from "./loop";
import { buildGate } from "./detect-gate";
import {
  saveSession,
  latestSession,
  listSessions,
  pruneSessions,
  persistenceEnabled,
  type ISessionRecord,
} from "./session-store";

/**
 * The tsforge CLI — the product surface over the same engine the eval harness
 * uses (see cli-product-direction). Like any agentic CLI: cd into a repo, run it,
 * and talk. The agent reads/runs/edits the whole workspace by default.
 *
 *   tsforge                       # interactive session in the current repo
 *   tsforge --dir ~/app           # ...in another repo
 *   tsforge "fix the build"       # interactive, with that as the first message
 *   tsforge "fix X" --accept "npm test"   # one-shot: drive to green, then exit
 *   tsforge --continue            # resume the most recent session for this dir
 *
 * The eval-only knobs are now OPTIONAL refinements, never required:
 *   --files "<globs>"   narrow the editable scope (default: the whole workspace)
 *   --accept "<cmd>"    a gate that confirms "done" (default: stop when the model
 *                       stops — like any chat agent). With a gate set, tsforge's
 *                       deterministic check enforces correctness; it can't be faked.
 * Slash commands (/help, /clear, /exit) follow the standard harness UX. Provider
 * via TSFORGE_* env.
 */
export interface ICliArgs {
  /** Empty ⇒ interactive REPL; non-empty ⇒ one-shot task. */
  task: string;
  dir: string;
  files: string[];
  accept: string;
  /** Resume the most recent saved session for this dir (`--continue` / `-c`). */
  continue: boolean;
  /** Skip auto-detecting a gate from the project (`--no-gate`). */
  noGate: boolean;
  /** An HTML file to render-check in headless chromium as part of the gate (`--browser`). */
  browser: string;
}

/** Parse argv (without `bun cli.ts`). Always succeeds — mode is decided in main. */
export function parseArgs(argv: readonly string[]): ICliArgs {
  const positional: string[] = [];
  let dir = ".";
  let files: string[] = [];
  let accept = "";
  let resume = false;
  let noGate = false;
  let browser = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--continue" || arg === "-c") {
      resume = true;
      continue;
    }

    if (arg === "--no-gate") {
      noGate = true;
      continue;
    }

    const next = argv[i + 1];
    const wantsValue =
      arg === "--dir" ||
      arg === "--files" ||
      arg === "--accept" ||
      arg === "--gate" ||
      arg === "--browser";

    if (wantsValue) {
      if (next === undefined) {
        continue;
      }

      if (arg === "--dir") {
        dir = next;
      } else if (arg === "--files") {
        files = next
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (arg === "--browser") {
        browser = next;
      } else {
        accept = next;
      }

      i += 1;
      continue;
    }

    positional.push(arg);
  }

  return {
    task: positional.join(" ").trim(),
    dir: isAbsolute(dir) ? dir : join(process.cwd(), dir),
    files,
    accept,
    continue: resume,
    noGate,
    browser,
  };
}

// Default editable scope: the whole workspace — like any agentic CLI, the agent
// may edit any file. `--files` only NARROWS this (a safety/eval tripwire); it's
// never required. `**/*` matches top-level and nested paths alike.
const WHOLE_REPO = ["**/*"];

/** Resolve the editable scope: an explicit `--files` narrowing, else the whole repo. */
function scopeOf(args: ICliArgs): string[] {
  return args.files.length > 0 ? args.files : WHOLE_REPO;
}

/** One-shot mode = a task PLUS a gate to drive to green; else interactive. */
export function isOneShot(args: ICliArgs): boolean {
  return args.task.length > 0 && args.accept.length > 0;
}

/** A unique-enough id for a new session (time + a little randomness). */
function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Human label for an editable scope (the whole-repo default reads nicer). */
function scopeLabel(files: string[]): string {
  return files.length === 1 && files[0] === "**/*"
    ? "entire workspace"
    : files.join(", ");
}

/** The host:port of an API base URL, for the banner (falls back to the raw url). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The active model id + endpoint host (env overrides, else defaults). */
function modelInfo(): { model: string; endpoint: string } {
  return {
    model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
    endpoint: hostOf(process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl),
  };
}

function makeProvider(): IProvider {
  return new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
    model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: Number(
      process.env.TSFORGE_MAX_TOKENS ?? String(PROVIDER_LIMITS.maxTokens)
    ),
  });
}

/** List saved sessions for a directory (the `/sessions` command). */
async function printSessions(dir: string): Promise<void> {
  const sessions = await listSessions(dir);

  if (sessions.length === 0) {
    process.stdout.write("no saved sessions for this directory\n");

    return;
  }

  for (const s of sessions) {
    const firstUser = s.messages.find((m) => m.role === "user")?.content ?? "";
    const snippet = firstUser.slice(0, 48).replace(/\s+/g, " ");

    process.stdout.write(
      `  ${s.id}  ${String(s.messages.length).padStart(3)} msgs  ${snippet}\n`
    );
  }
}

const render: Reporter = (event) => {
  process.stdout.write(renderEvent(event, { color: true }));
};

/** One-shot: drive a single task to green, then exit. */
async function runOnce(args: ICliArgs): Promise<number> {
  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: scopeOf(args),
    context: [],
  };

  const result = await runTask(task, args.dir, makeProvider(), {
    onEvent: render,
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  return ok ? 0 : 1;
}

const HELP = [
  "Commands:",
  "  /help            show this help",
  "  /compact         summarize the conversation to free up context",
  "  /clear           reset the conversation (keeps the workspace + gate)",
  "  /gate <cmd>      set the gate command (empty to clear)",
  "  /files <globs>   set the editable scope (comma-separated; empty = all)",
  "  /model           show the active model + endpoint",
  "  /sessions        list saved sessions for this directory",
  "  /exit, /quit     leave the session",
  "",
  "Anything else is sent to the agent. It works with its tools; when it stops,",
  'the gate (if set) confirms "done".',
].join("\n");

/** The session status line — distinguishes off / new / resumed. */
function sessionLine(id: string, resumed: ISessionRecord | null): string {
  if (!persistenceEnabled()) {
    return "  session: not saved (TSFORGE_NO_PERSIST)";
  }

  return resumed === null
    ? `  session: new (${id})`
    : `  session: resumed ${resumed.messages.length} message(s)`;
}

/** Print the welcome banner, session info, and (when resuming) the prior transcript. */
function printHeader(info: {
  dir: string;
  id: string;
  gateLabel: string;
  files: string[];
  resumed: ISessionRecord | null;
}): void {
  const { dir, id, gateLabel, files, resumed } = info;

  process.stdout.write(welcomeBanner(modelInfo()));
  process.stdout.write(
    [
      `  cwd:   ${dir}`,
      `  scope: ${scopeLabel(files)}`,
      `  gate:  ${gateLabel}`,
      sessionLine(id, resumed),
      "  /help for commands, /exit to quit",
      "",
    ].join("\n")
  );

  if (resumed === null) {
    return;
  }

  // Replay the prior conversation so a resumed session has visible context.
  process.stdout.write("\n── resuming conversation ──\n");

  for (const message of resumed.messages) {
    process.stdout.write(renderMessage(message, { color: true }));
  }

  process.stdout.write("\n──────────────────────────\n");
}

// tsforge's bundled browser-check script (headless-chromium render oracle).
const BROWSER_CHECK = join(
  import.meta.dir,
  "..",
  "scripts",
  "browser-check.ts"
);

function browserCheckCommand(htmlFile: string): string {
  return `bun "${BROWSER_CHECK}" "${htmlFile}"`;
}

/**
 * Resolve the session's gate + label. Starts from the base gate (resumed /
 * explicit / auto strict-TS), then appends a `--browser` render check when asked
 * — so a web build is verified to actually RUN, not just type-check.
 */
async function resolveGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<{ accept: string; gateLabel: string }> {
  const base = await baseGate(args, resumed);

  if (args.browser.length === 0) {
    return base;
  }

  const browser = browserCheckCommand(args.browser);

  return {
    accept: base.accept.length > 0 ? `${base.accept} && ${browser}` : browser,
    gateLabel:
      base.accept.length > 0
        ? `${base.gateLabel} + browser render`
        : "browser render",
  };
}

/** The base gate: a resumed session's gate wins, then explicit `--accept`, then
 *  `--no-gate` (off), else tsforge's auto gate (strict-TS / project lint). */
async function baseGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<{ accept: string; gateLabel: string }> {
  if (resumed !== null) {
    const label = resumed.accept.length > 0 ? resumed.accept : "none";

    return { accept: resumed.accept, gateLabel: label };
  }

  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  const auto = await buildGate(args.dir);

  return { accept: auto.command, gateLabel: auto.label };
}

/** Interactive REPL: a persistent gate-anchored conversation. */
async function repl(args: ICliArgs): Promise<number> {
  const provider = makeProvider();

  // Best-effort cleanup of stale sessions on every launch.
  await pruneSessions();

  // --continue resumes the most recent saved session for this directory.
  const resumed = args.continue ? await latestSession(args.dir) : null;

  if (args.continue && resumed === null) {
    process.stdout.write(
      "(no saved session for this directory — starting fresh)\n"
    );
  }

  const id = resumed?.id ?? newSessionId();
  const { accept, gateLabel } = await resolveGate(args, resumed);
  const files = resumed !== null ? resumed.files : scopeOf(args);
  const config = {
    provider,
    cwd: args.dir,
    files,
    accept,
    report: render,
    ...(resumed === null ? {} : { history: resumed.messages }),
  };

  let session = await Session.create(config);

  const persist = async (): Promise<void> => {
    await saveSession({
      id,
      cwd: args.dir,
      accept,
      files,
      updatedAt: Date.now(),
      messages: [...session.messages],
    });
  };

  printHeader({ dir: args.dir, id, gateLabel, files, resumed });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl-C: while a turn is running, abort it and return to the prompt; while
  // idle at the prompt, quit. (readline emits SIGINT on the interface, so the
  // process isn't killed — we decide what it means.)
  let active: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (active !== null) {
      active.abort();
    } else {
      rl.close();
    }
  });

  const dispatch = async (line: string): Promise<void> => {
    active = new AbortController();

    try {
      const result = await session.send(line, active.signal);

      process.stdout.write(`\n[${result.status} · ${result.turns} turn(s)]\n`);
    } finally {
      active = null;
    }

    await persist();
  };

  // Slash-command dispatch. Returns true to EXIT the REPL. Kept as a closure so
  // it can rebuild `session` (e.g. /clear) and reach config/persist.
  const command = async (line: string): Promise<boolean> => {
    const [verb, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch ((verb ?? "").toLowerCase()) {
      case "exit":
      case "quit":
        return true;
      case "help":
        process.stdout.write(`${HELP}\n`);
        break;
      case "clear":
        session = await Session.create(config);
        await persist();
        process.stdout.write("conversation cleared\n");
        break;

      case "compact": {
        const { before, after } = await session.compact();

        await persist();
        process.stdout.write(`compacted ${before} → ${after} messages\n`);
        break;
      }

      case "gate":
        session.setGate(arg);
        process.stdout.write(
          arg.length > 0 ? `gate: ${arg}\n` : "gate cleared\n"
        );
        break;

      case "files": {
        const globs = arg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        session.setScope(globs.length > 0 ? globs : WHOLE_REPO);
        process.stdout.write(`scope: ${scopeLabel(session.scope)}\n`);
        break;
      }

      case "model": {
        const { model, endpoint } = modelInfo();

        process.stdout.write(`  model: ${model}\n  endpoint: ${endpoint}\n`);
        break;
      }

      case "sessions":
        await printSessions(args.dir);
        break;
      default:
        process.stdout.write(`unknown command: ${line} (try /help)\n`);
    }

    return false;
  };

  // A positional task given on the command line is sent as the first message.
  if (args.task.length > 0) {
    await dispatch(args.task);
  }

  // Iterate the interface (not question()-in-a-loop) so buffered/piped input is
  // handled as well as interactive TTY input. The body backpressures reads — the
  // next line isn't pulled until the current send/command finishes.
  process.stdout.write("\n› ");

  for await (const raw of rl) {
    const line = raw.trim();

    if (line.length === 0) {
      process.stdout.write("› ");
      continue;
    }

    if (line.startsWith("/")) {
      if (await command(line)) {
        break;
      }

      process.stdout.write("\n› ");
      continue;
    }

    await dispatch(line);
    process.stdout.write("\n› ");
  }

  rl.close();

  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // A positional task with a scope + gate ⇒ one-shot; otherwise interactive.
  return isOneShot(args) ? runOnce(args) : repl(args);
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `tsforge: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
