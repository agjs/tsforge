#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runTask, RUN_STATUS, Session } from "./loop";
import {
  PROVIDER_LIMITS,
  OpenAICompatibleProvider,
  PROVIDER_DEFAULTS,
  type IProvider,
} from "./inference";
import {
  renderEvent,
  renderMessage,
  renderStatus,
  welcomeBanner,
} from "./render";
import type { ITask } from "./spec";
import type { Reporter } from "./loop";
import {
  buildGate,
  buildWebGate,
  buildWebFix,
  buildWebTypeGate,
  buildWebTscCheck,
  scaffoldWeb,
  installWebDeps,
  webGuidance,
} from "./detect-gate";
import type { WebFramework } from "./web-templates";
import { classifyIntent } from "./classify";
import { isRecord } from "./lib/guards";
import {
  saveSession,
  latestSession,
  loadSession,
  listSessions,
  pruneSessions,
  persistenceEnabled,
  logsDir,
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
 *   --log               record the full event stream (reasoning, every file the
 *                       agent writes, gate verdicts, timing) as JSONL to an
 *                       auto-named ~/.tsforge/logs/<timestamp>-<id>.jsonl — the
 *                       record to evaluate runs and see where the model got stuck.
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
  /** Resume a specific session by id (`--resume <id>`). */
  resumeId: string;
  /** Skip auto-detecting a gate from the project (`--no-gate`). */
  noGate: boolean;
  /** An HTML file to render-check in headless chromium as part of the gate (`--browser`). */
  browser: string;
  /** Scaffold + gate a web app: skeleton + tsc/eslint/build/browser ladder (`--web`). */
  web: boolean;
  /** Append the full event stream (reasoning, tool writes, gate verdicts) as JSONL
   *  to an auto-named file under ~/.tsforge/logs/ for later evaluation (`--log`). */
  log: boolean;
}

const BOOL_FLAGS: Record<string, "continue" | "noGate" | "web" | "log"> = {
  "--continue": "continue",
  "-c": "continue",
  "--no-gate": "noGate",
  "--web": "web",
  "--log": "log",
};

const VALUE_FLAGS = new Set([
  "--dir",
  "--files",
  "--accept",
  "--gate",
  "--browser",
  "--resume",
]);

/** Parse argv (without `bun cli.ts`). Always succeeds — mode is decided in main. */
export function parseArgs(argv: readonly string[]): ICliArgs {
  const positional: string[] = [];
  const out: ICliArgs = {
    task: "",
    dir: ".",
    files: [],
    accept: "",
    continue: false,
    resumeId: "",
    noGate: false,
    browser: "",
    web: false,
    log: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    const boolKey = BOOL_FLAGS[arg];

    if (boolKey !== undefined) {
      out[boolKey] = true;
    } else if (VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined) {
      applyValueFlag(arg, argv[i + 1] ?? "", out);
      i += 1;
    } else if (!VALUE_FLAGS.has(arg)) {
      positional.push(arg);
    }
  }

  out.task = positional.join(" ").trim();
  out.dir = isAbsolute(out.dir) ? out.dir : join(process.cwd(), out.dir);

  return out;
}

/** Assign one `--flag value` into the args (mutates `out`). */
function applyValueFlag(flag: string, value: string, out: ICliArgs): void {
  if (flag === "--dir") {
    out.dir = value;
  } else if (flag === "--files") {
    out.files = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (flag === "--browser") {
    out.browser = value;
  } else if (flag === "--resume") {
    out.resumeId = value;
  } else {
    out.accept = value; // --accept / --gate
  }
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

/** The model's real context window, read from the server's `/models`
 *  (`max_model_len` — vLLM/OpenAI-compatible). Best-effort: undefined if the
 *  endpoint is unreachable or doesn't report it (caller falls back). 3s cap so a
 *  dead endpoint can't stall CLI startup. */
async function detectContextWindow(): Promise<number | undefined> {
  const base = process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl;
  const model = process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model;
  const headers: Record<string, string> = {};

  if (process.env.TSFORGE_API_KEY !== undefined) {
    headers.authorization = `Bearer ${process.env.TSFORGE_API_KEY}`;
  }

  try {
    const res = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return undefined;
    }

    const data: unknown = await res.json();

    if (!isRecord(data) || !Array.isArray(data.data)) {
      return undefined;
    }

    const entries = data.data.filter(isRecord);
    const match = entries.find((e) => e.id === model) ?? entries[0];
    const len = match?.max_model_len;

    return typeof len === "number" && Number.isFinite(len) ? len : undefined;
  } catch {
    return undefined;
  }
}

function frameworkLabel(framework: WebFramework): string {
  return framework === "react"
    ? "Vite + React + shadcn/ui + TanStack"
    : "Vite + TypeScript + Tailwind";
}

/** The short spec Q&A shown when a web app is detected — confirm the stack + grab
 *  any extra intent before scaffolding (we don't silently impose a framework). */
const WEB_SPEC_PROMPT = `${[
  "",
  "  This looks like a web app. Two quick things before I scaffold:",
  "    1. Framework — react (full kit: shadcn/ui + TanStack Router + Query) [default],",
  "       or vanilla (Vite + TypeScript + Tailwind).   (vue/svelte coming soon)",
  "    2. Anything specific? — key features, pages, data (optional).",
  '  Reply on one line (e.g. "react — todo app with due dates"), or press Enter for the React kit.',
].join("\n")}\n`;

/** Parse a spec-Q&A reply: pick the framework (default react) and keep the rest as
 *  extra task detail. */
function parseSpec(line: string): { framework: WebFramework; extra: string } {
  const framework: WebFramework = /\bvanilla\b/i.test(line)
    ? "vanilla"
    : "react";
  const extra = line
    .replace(/^\s*(react|vanilla|vue|svelte)\b[\s:.\-—]*/i, "")
    .trim();

  return { framework, extra };
}

/** Lay down a stack's skeleton and install its dependencies, reporting progress —
 *  the model can't build until deps resolve. */
async function setUpWebProject(
  dir: string,
  framework: WebFramework
): Promise<void> {
  await scaffoldWeb(dir, framework);
  process.stdout.write(`  ↳ installing ${frameworkLabel(framework)}…\n`);

  const ok = await installWebDeps(dir);

  process.stdout.write(
    ok
      ? "  ↳ dependencies ready\n"
      : "  ⚠ dependency install failed — run `bun install` yourself\n"
  );
}

/** Parse a numeric env var, returning undefined for unset/blank/non-numeric
 *  input (never NaN — a NaN reaching the provider serializes to `null` in the
 *  request body and the model request fails confusingly). */
function envNumber(name: string): number | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const value = Number(raw);

  return Number.isFinite(value) ? value : undefined;
}

function makeProvider(): IProvider {
  const repetitionPenalty = envNumber("TSFORGE_REPETITION_PENALTY");

  return new OpenAICompatibleProvider({
    baseUrl: process.env.TSFORGE_BASE_URL ?? PROVIDER_DEFAULTS.baseUrl,
    model: process.env.TSFORGE_MODEL ?? PROVIDER_DEFAULTS.model,
    apiKey: process.env.TSFORGE_API_KEY,
    maxTokens: envNumber("TSFORGE_MAX_TOKENS") ?? PROVIDER_LIMITS.maxTokens,
    // OFF by default: a global repetition penalty also penalizes the rigid,
    // repetitive tool-call JSON tokens, which pushes the model to NARRATE
    // instead of emitting tool calls (→ no files written). The StreamGuard is
    // the targeted loop protection. Opt in only to experiment.
    ...(repetitionPenalty === undefined ? {} : { repetitionPenalty }),
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

/** Reporter that renders to the terminal AND, when `--log <file>` is set, appends
 *  the full event stream as JSONL (one event per line, timestamped) for later
 *  evaluation — the durable record of what the agent did: its reasoning, every
 *  file it wrote, the gate verdicts, and the loops it got stuck in. Append-only
 *  (NOT overwritten like the session JSON), and unredacted — it's an opt-in local
 *  debug artifact. Logging failures never break the session. */
function makeReporter(logFile: string): Reporter {
  if (logFile.length === 0) {
    return render;
  }

  return (event) => {
    render(event);

    try {
      appendFileSync(
        logFile,
        `${JSON.stringify({ t: Date.now(), ...event })}\n`
      );
    } catch {
      // A logging failure must never interrupt the session.
    }
  };
}

/** Resolve the run-log file when `--log` is set: an auto-named, timestamped JSONL
 *  under ~/.tsforge/logs/ (created if needed), so logs are always in one findable
 *  place and you never specify a path. Empty string = logging off. */
function resolveLogPath(id: string, enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  const dir = logsDir();

  mkdirSync(dir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");

  return join(dir, `${stamp}-${id}.jsonl`);
}

/** One-shot: drive a single task to green, then exit. */
async function runOnce(args: ICliArgs): Promise<number> {
  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: scopeOf(args),
    context: [],
  };

  const logFile = resolveLogPath("cli", args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  const result = await runTask(task, args.dir, makeProvider(), {
    onEvent: makeReporter(logFile),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
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
  "  /sessions        list saved sessions (resume one with: tsforge --resume <id>)",
  "  /cost            rough conversation size (messages + ~tokens)",
  "  /exit, /quit     leave the session",
  "",
  "Anything else is sent to the agent. It works with its tools; when it stops,",
  'the gate (if set) confirms "done".',
  "While it's working: type a message to STEER the next turn (e.g. 'use Tailwind');",
  "Ctrl-C interrupts the current run.",
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

  if (args.web) {
    const web = buildWebGate("react");

    return { accept: web.command, gateLabel: web.label };
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

  // --resume <id> loads a specific session; --continue the newest for this dir.
  const resumed =
    args.resumeId.length > 0
      ? await loadSession(args.resumeId)
      : args.continue
        ? await latestSession(args.dir)
        : null;

  if ((args.continue || args.resumeId.length > 0) && resumed === null) {
    process.stdout.write("(no matching saved session — starting fresh)\n");
  }

  // --web: lay down the opinionated skeleton before resolving the gate.
  if (args.web && resumed === null) {
    await setUpWebProject(args.dir, "react");
  }

  const id = resumed?.id ?? newSessionId();
  const { accept, gateLabel } = await resolveGate(args, resumed);
  const files = resumed !== null ? resumed.files : scopeOf(args);
  const logFile = resolveLogPath(id, args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  // Auto-compaction threshold (fraction of the window); session default 0.8.
  const autoCompactAt = envNumber("TSFORGE_COMPACT_AT");
  // The model's real context window: explicit env wins, else ask the server
  // (max_model_len), else a conservative fallback. Drives the status gauge AND
  // auto-compaction (the session compacts before a send once it nears the window).
  const contextWindow =
    envNumber("TSFORGE_CONTEXT_WINDOW") ??
    (await detectContextWindow()) ??
    32_768;
  const report = makeReporter(logFile);
  const config = {
    provider,
    cwd: args.dir,
    files,
    accept,
    contextWindow,
    report,
    ...(resumed === null ? {} : { history: resumed.messages }),
    ...(args.web
      ? {
          guidance: webGuidance("react"),
          fix: buildWebFix("react"),
          incrementalCheck: buildWebTscCheck(),
        }
      : {}),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
  };

  let session = await Session.create(config);

  // A self-describing run-meta line at the top of the --log so the analyzer knows
  // which model / context window the metrics are against (the thread's advice:
  // many "model failures" are really quant/config failures — record the config).
  report({
    kind: "start",
    task: "session",
    message: `model ${modelInfo().model} · context window ${contextWindow}`,
    model: modelInfo().model,
    contextWindow,
  });

  const persist = async (): Promise<void> => {
    await saveSession({
      id,
      cwd: args.dir,
      // The LIVE gate/scope — not the startup constants. /gate, /files, and a web
      // scaffold all mutate these mid-session; persisting the originals would
      // silently restore stale settings on --continue. See P2 review.
      accept: session.gate,
      files: session.scope,
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
  // Lines typed WHILE a run is in flight — drained at each turn boundary to steer
  // the model (see Session.send `steer`), instead of blocking until the run ends.
  const pending: string[] = [];

  rl.on("SIGINT", () => {
    if (active !== null) {
      active.abort();
    } else {
      rl.close();
    }
  });

  // On a PLAIN session (no explicit mode/gate), classify the first message and
  // route to an opinionated approach — so "build me a todo app" gets a structured,
  // tooled web scaffold instead of an improvised single-file blob.
  let classified = false;
  // While set, the next user line is the answer to the web spec Q&A (it holds the
  // original build request, deferred until we know the stack).
  let awaitingSpec: string | null = null;
  // Explicit `--web` (no classify Q&A): the FIRST message is the build, so stage
  // it (plan+types → implement). Cleared after, so follow-ups are plain sends.
  let stagedWebPending = args.web && resumed === null;
  const autoClassify =
    resumed === null && !args.web && args.accept.length === 0 && !args.noGate;

  const configureWeb = async (framework: WebFramework): Promise<void> => {
    process.stdout.write(
      `\n  ↳ scaffolding a ${frameworkLabel(framework)} project\n`
    );
    await setUpWebProject(args.dir, framework);
    session.setGate(buildWebGate(framework).command);
    session.setFix(buildWebFix(framework));
    session.setIncrementalCheck(buildWebTscCheck());
    session.guide(webGuidance(framework));
  };

  // Last-turn summary, surfaced in the status line shown before each prompt.
  let lastTurns = 0;
  let lastElapsedMs = 0;
  let lastStatus = "ready";

  // Run one user-driven exchange: fresh abort controller, time it, record the
  // outcome for the status line, persist. `run` gets the live signal + a steer
  // drain so in-flight user messages reach the model.
  const drive = async (
    run: (opts: { signal: AbortSignal; steer: () => string[] }) => Promise<{
      status: string;
      turns: number;
    }>
  ): Promise<void> => {
    active = new AbortController();
    const started = performance.now();

    try {
      const result = await run({
        signal: active.signal,
        steer: () => pending.splice(0, pending.length),
      });

      lastTurns = result.turns;
      lastElapsedMs = performance.now() - started;
      lastStatus = result.status;
    } finally {
      active = null;
    }

    await persist();
  };

  const runSend = (line: string): Promise<void> =>
    drive((opts) => session.send(line, opts));

  // A from-scratch web build: stage it (plan + types, then implement) so the
  // model designs the type contract before writing UI — far less API invention.
  // The design phase gates on TYPES only (tsc + lint) so contract errors surface
  // early and small, not as a final avalanche.
  const runStagedBuild = (
    line: string,
    framework: WebFramework
  ): Promise<void> =>
    drive((opts) =>
      session.buildStaged(line, opts, buildWebTypeGate(framework).command)
    );

  const dispatch = async (line: string): Promise<void> => {
    // A reply to the web spec Q&A: pick the stack, scaffold, then run the request.
    if (awaitingSpec !== null) {
      const request = awaitingSpec;

      awaitingSpec = null;

      if (/\b(vue|svelte)\b/i.test(line)) {
        process.stdout.write(
          "  ↳ vue/svelte coming soon — using the React full kit\n"
        );
      }

      const { framework, extra } = parseSpec(line);

      await configureWeb(framework);
      // Staged build: design the types first, then implement against them.
      await runStagedBuild(
        extra.length > 0 ? `${request}\n\nDetails: ${extra}` : request,
        framework
      );

      return;
    }

    // Explicit --web: the first message is a from-scratch build — stage it.
    if (stagedWebPending) {
      stagedWebPending = false;
      await runStagedBuild(line, "react");

      return;
    }

    // First message: classify. A web app pauses for a short spec Q&A before scaffolding.
    if (autoClassify && !classified) {
      classified = true;

      if ((await classifyIntent(provider, line)) === "web") {
        awaitingSpec = line;
        process.stdout.write(WEB_SPEC_PROMPT);

        return;
      }
    }

    await runSend(line);
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
        // Persist immediately so a `/gate` change survives even if the user quits
        // before the next send (persist otherwise only runs after a turn).
        await persist();
        break;

      case "files": {
        const globs = arg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        session.setScope(globs.length > 0 ? globs : WHOLE_REPO);
        process.stdout.write(`scope: ${scopeLabel(session.scope)}\n`);
        await persist();
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

      case "cost": {
        const chars = session.messages.reduce(
          (sum, m) => sum + m.content.length,
          0
        );

        process.stdout.write(
          `  ${String(session.messages.length)} messages · ~${String(Math.round(chars / 4))} tokens (rough)\n`
        );
        break;
      }

      default:
        process.stdout.write(`unknown command: ${line} (try /help)\n`);
    }

    return false;
  };

  // The persistent status line, shown above every prompt so the model, real
  // context-window usage, scope, and last-turn outcome are always in view.
  const prompt = (): void => {
    process.stdout.write("\n");
    process.stdout.write(
      renderStatus({
        model: modelInfo().model,
        contextTokens: session.contextTokens,
        contextWindow,
        turns: lastTurns,
        elapsedMs: lastElapsedMs,
        status: lastStatus,
        scope: scopeLabel(session.scope),
      })
    );
    process.stdout.write("› ");
  };

  await new Promise<void>((resolveLoop) => {
    let busy = false;
    let closed = false;

    // Finish the loop only when stdin has closed AND no run is in flight — so a
    // stdin EOF (piped input / Ctrl-D) never kills a build mid-turn.
    const maybeFinish = (): void => {
      if (closed && !busy) {
        resolveLoop();
      }
    };

    // Handle one idle line (slash command or a message), then any queued follow-up.
    const runLine = async (line: string): Promise<void> => {
      busy = true;

      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            rl.close();

            return;
          }
        } else {
          await dispatch(line);
        }
      } finally {
        busy = false;
      }

      // A line typed in the gap after the last steer-drain becomes the next turn.
      const next = pending.shift();

      if (next !== undefined) {
        void runLine(next);

        return;
      }

      if (closed) {
        maybeFinish();
      } else {
        prompt();
      }
    };

    // Event-driven (not for-await) so stdin is read DURING a run: a line typed
    // mid-run is queued to steer the next turn (or, if "/exit", aborts). This is
    // what makes it feel like a real harness — you can redirect without waiting.
    rl.on("line", (raw) => {
      const line = raw.trim();

      if (line.length === 0) {
        // An empty line while awaiting the spec answer = accept the defaults.
        if (awaitingSpec !== null && !busy) {
          void runLine("");
        } else if (!busy) {
          prompt();
        }

        return;
      }

      if (busy) {
        if (line === "/exit" || line === "/quit") {
          active?.abort();
          rl.close();
        } else {
          pending.push(line);
          process.stdout.write("  ↳ queued (steers the next turn)\n");
        }

        return;
      }

      void runLine(line);
    });

    rl.on("close", () => {
      closed = true;
      maybeFinish();
    });

    if (args.task.length > 0) {
      void runLine(args.task); // sent as the first message; prompts when done
    } else {
      prompt();
    }
  });

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
