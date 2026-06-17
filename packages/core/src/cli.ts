#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { formatHelp, takesArg } from "./cli/commands";
import { pickCommand } from "./render/command-menu";
import {
  runTask,
  RUN_STATUS,
  Session,
  PLAN_APPROVED_NOTE,
  reviewChange,
  formatReport,
} from "./loop";
import {
  PROVIDER_LIMITS,
  PROVIDER_DEFAULTS,
  OpenAICompatibleProvider,
  type IOpenAICompatibleConfig,
} from "./inference";
import {
  resolveActiveModel,
  setActiveModel,
  loadModelsConfig,
  resolveApiKey,
  type IModelEntry,
} from "./models-config";
import {
  renderEvent,
  renderMessage,
  renderStatus,
  StatusBar,
  welcomeBanner,
  STYLE,
  RESET,
  type IStatusInfo,
} from "./render";
import type { ITask } from "./spec";
import type { Reporter, ILoopEvent } from "./loop";
import { loadLedger, activeRules, forgetMemory } from "./loop/memory";
import {
  buildGate,
  buildWebGate,
  buildWebFix,
  buildCoreFix,
  buildWebTypeGate,
  buildWebTscCheck,
  scaffoldWeb,
  installWebDeps,
  webGuidance,
} from "./detect-gate";
import type { WebFramework } from "./web-templates";
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
import {
  currentVersion,
  getUpdateNotice,
  refreshUpdateCacheInBackground,
} from "./update-check";

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
  /** Plan mode: a from-scratch build pauses after the design phase to show its
   *  plan for review/edit before implementing (`--plan`; also toggled by /plan). */
  plan: boolean;
  /** Keep the auto-gate at the strict TS floor only — do NOT append the
   *  project's discovered tests (`--strict-floor-only`). By default the auto-gate
   *  also runs the project's tests, so "green" means floor + tests pass. */
  strictFloorOnly: boolean;
  /** Review the change you're on (functional review of the diff) (`tsforge review`). */
  review: boolean;
  /** Review only staged changes (`--staged`). */
  staged: boolean;
  /** Explicit base ref to diff against for review (`--base <ref>`). */
  base: string;
}

const BOOL_FLAGS: Record<
  string,
  "continue" | "noGate" | "web" | "log" | "plan" | "strictFloorOnly" | "staged"
> = {
  "--continue": "continue",
  "-c": "continue",
  "--no-gate": "noGate",
  "--web": "web",
  "--log": "log",
  "--plan": "plan",
  "--strict-floor-only": "strictFloorOnly",
  "--staged": "staged",
};

const VALUE_FLAGS = new Set([
  "--dir",
  "--files",
  "--accept",
  "--gate",
  "--browser",
  "--resume",
  "--base",
]);

/** Parse argv (without the tsforge binary name). Always succeeds — mode is decided in main. */
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
    plan: false,
    strictFloorOnly: false,
    review: false,
    staged: false,
    base: "",
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

  // `tsforge review` is a subcommand, not a task: the first positional selects it.
  if (positional[0] === "review") {
    out.review = true;
    out.task = positional.slice(1).join(" ").trim();
  }

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
  } else if (flag === "--base") {
    out.base = value;
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

/** The active model id + endpoint host, from a wire-config (provider.config) or a
 *  registry entry — both carry `model` + `baseUrl`. */
function modelInfo(src: { model: string; baseUrl: string }): {
  model: string;
  endpoint: string;
} {
  return { model: src.model, endpoint: hostOf(src.baseUrl) };
}

/** The model's real context window, read from the server's `/models`
 *  (`max_model_len` — vLLM/OpenAI-compatible). Best-effort: undefined if the
 *  endpoint is unreachable or doesn't report it (caller falls back). 3s cap so a
 *  dead endpoint can't stall CLI startup. */
async function detectContextWindow(
  entry: IModelEntry
): Promise<number | undefined> {
  const headers: Record<string, string> = {};
  const key = resolveApiKey(entry);

  if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  }

  try {
    const res = await fetch(`${entry.baseUrl}/models`, {
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
    const match = entries.find((e) => e.id === entry.model) ?? entries[0];
    // vLLM uses `max_model_len`; other servers expose `context_window` or
    // `max_position_embeddings` — accept whichever is present.
    const len =
      match?.max_model_len ??
      match?.context_window ??
      match?.max_position_embeddings;

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

/** The `/metrics` turns-to-green line (loop-efficiency: turns the last green run
 *  took). Extracted so the command switch stays a flat dispatch. */
function turnsToGreenLine(turns: number | null): string {
  return turns === null
    ? "  turns to green: — (no green run yet)\n"
    : `  turns to green (last): ${String(turns)}\n`;
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

/** Wire-config from a registry entry: API key resolved at use time (inline or
 *  via apiKeyEnv); env still tunes maxTokens/penalty. Shared by initial
 *  construction, `/model` hot-swap, and the interactive eval script — so they
 *  all behave identically. */
export function providerConfig(entry: IModelEntry): IOpenAICompatibleConfig {
  const repetitionPenalty = envNumber("TSFORGE_REPETITION_PENALTY");

  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens:
      entry.maxTokens ??
      envNumber("TSFORGE_MAX_TOKENS") ??
      PROVIDER_LIMITS.maxTokens,
    // OFF by default: a global repetition penalty also penalizes the rigid,
    // repetitive tool-call JSON tokens, which pushes the model to NARRATE
    // instead of emitting tool calls (→ no files written). The StreamGuard is
    // the targeted loop protection. Opt in only to experiment.
    ...(repetitionPenalty === undefined ? {} : { repetitionPenalty }),
    // Provider dialect + escape hatches — passed straight through so any
    // OpenAI-ish endpoint (DeepSeek, OpenAI o-series, custom gateways) works.
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    ...(entry.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: entry.reasoningEffort }),
    ...(entry.extraBody === undefined ? {} : { extraBody: entry.extraBody }),
    ...(entry.extraHeaders === undefined
      ? {}
      : { extraHeaders: entry.extraHeaders }),
  };
}

function makeProvider(entry: IModelEntry): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(providerConfig(entry));
}

/** Catch the common footgun: a cloud baseUrl paired with the leftover qwen
 *  default `model`, which then 400s ("model not supported") on that host. */
function warnDefaultModelOnRemote(entry: IModelEntry): void {
  let host: string;

  try {
    host = new URL(entry.baseUrl).hostname;
  } catch {
    return;
  }

  const remote = host !== "localhost" && host !== "127.0.0.1" && host !== "::1";

  if (remote && entry.model === PROVIDER_DEFAULTS.model) {
    process.stdout.write(
      `  ⚠ models.json: model is still "${PROVIDER_DEFAULTS.model}" (the default) but baseUrl is ${host} — set the entry's "model" to a name that host supports.\n`
    );
  }
}

/** Print the model registry with ★ on the active one (the `/model` listing). */
async function listModels(
  provider: OpenAICompatibleProvider,
  activeName: string
): Promise<void> {
  const cfg = await loadModelsConfig();
  const current = modelInfo(provider.config);

  process.stdout.write(
    `  active: ${activeName} — ${current.model} @ ${current.endpoint}\n`
  );

  for (const [name, e] of Object.entries(cfg.models)) {
    const mark = name === activeName ? "★" : " ";

    process.stdout.write(
      `  ${mark} ${name}  ${e.model} @ ${hostOf(e.baseUrl)}\n`
    );
  }

  if (activeName === "env") {
    process.stdout.write(
      "  (TSFORGE_* env is overriding the registry — unset it to use /model)\n"
    );
  }

  process.stdout.write("  switch with: /model <name>\n");
}

/** Handle `/model [name]`: no arg lists the registry; a name persists it as active
 *  and HOT-SWAPS the live provider. Returns the (possibly updated) active name +
 *  context window for the caller to thread back into the REPL state. */
async function runModelCommand(opts: {
  arg: string;
  provider: OpenAICompatibleProvider;
  activeName: string;
  fallbackEntry: IModelEntry;
  contextWindow: number;
}): Promise<{ activeName: string; contextWindow: number }> {
  const { arg, provider, activeName, fallbackEntry, contextWindow } = opts;
  const wanted = arg.trim();

  if (wanted.length === 0) {
    await listModels(provider, activeName);

    return { activeName, contextWindow };
  }

  try {
    const next = await setActiveModel(wanted);
    const entry = next.models[wanted] ?? fallbackEntry;

    provider.reconfigure(providerConfig(entry));

    const window =
      entry.contextWindow ??
      (await detectContextWindow(entry)) ??
      contextWindow;
    const info = modelInfo(provider.config);

    process.stdout.write(
      `  ✓ switched to ${wanted} — ${info.model} @ ${info.endpoint} (context ${String(window)})\n`
    );

    return { activeName: wanted, contextWindow: window };
  } catch (err) {
    process.stdout.write(
      `  ${err instanceof Error ? err.message : String(err)}\n`
    );

    return { activeName, contextWindow };
  }
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_TICK_MS = 120;
const ERASE_LINE = `\r${String.fromCharCode(27)}[2K`;

/** Animated activity line (`⠋ thinking · 12s`) for the silent stretches of a
 *  turn — hidden chain-of-thought, prompt processing, a slow first token. TTY
 *  only. Any rendered event clears it before printing (the next tick redraws),
 *  so it never interleaves with streamed text or boxes. */
function makeSpinner(): {
  start: () => void;
  clear: () => void;
  stop: () => void;
  setLabel: (label: string) => void;
  onTick: (cb: () => void) => void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  let frame = 0;
  let drawn = false;
  let label = "thinking";
  let onTickCb: (() => void) | null = null;

  const clear = (): void => {
    if (drawn) {
      process.stdout.write(ERASE_LINE);
      drawn = false;
    }
  };

  const tick = (): void => {
    const secs = Math.round((performance.now() - startedAt) / 1000);

    frame = (frame + 1) % SPINNER_FRAMES.length;
    process.stdout.write(
      `${ERASE_LINE}  ${STYLE.dim}${SPINNER_FRAMES[frame] ?? ""} ${label} · ${secs}s${RESET}`
    );
    drawn = true;
    onTickCb?.(); // repaint the pinned status bar with live tok/s / context
  };

  return {
    start: (): void => {
      if (!process.stdout.isTTY || timer !== null) {
        return;
      }

      label = "thinking";
      startedAt = performance.now();
      timer = setInterval(tick, SPINNER_TICK_MS);
    },
    clear,
    stop: (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      clear();
    },
    setLabel: (l: string): void => {
      label = l;
    },
    onTick: (cb: () => void): void => {
      onTickCb = cb;
    },
  };
}

const spinner = makeSpinner();

/** What the spinner should say given the latest event — the activity line
 *  follows the turn's phase instead of claiming "thinking" during a gate run
 *  or a dependency install. Null = keep the current label. */
export function spinnerPhase(event: ILoopEvent): string | null {
  if (event.kind === "token") {
    if (event.channel === "tool") {
      return "writing";
    }

    return event.channel === "reasoning" ? "thinking" : null;
  }

  if (event.kind === "run" || event.kind === "validated") {
    return "checking";
  }

  if (event.kind === "tool" && /install/i.test(event.message)) {
    return "installing deps";
  }

  return event.kind === "cycle" ? "thinking" : null;
}

const render: Reporter = (event) => {
  const phase = spinnerPhase(event);

  if (phase !== null) {
    spinner.setLabel(phase);
  }

  const out = renderEvent(event, { color: true });

  if (out.length > 0) {
    spinner.clear();
    process.stdout.write(out);
  }
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
  const { entry } = await resolveActiveModel();
  const result = await runTask(task, args.dir, makeProvider(entry), {
    onEvent: makeReporter(logFile),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  return ok ? 0 : 1;
}

/** Wide approval — the staged-web checkpoint explicitly prompted "type
 *  'approve'", so casual yeses count there. */
export function isApproval(line: string): boolean {
  return /^(approve|approved|ok|okay|yes|y|go|lgtm)\.?$/i.test(line.trim());
}

/** Narrow approval — GENERAL plan mode, where the model asks clarifying
 *  questions: a "yes" may ANSWER a question, so only unambiguous approval
 *  words exit the mode and start implementing. */
export function isPlanApproval(line: string): boolean {
  return /^(approve|approved|go|lgtm|implement)[.!]?$/i.test(line.trim());
}

// The /help body is generated from the command registry (src/cli/commands.ts) so
// the help text and the interactive `/` palette can never drift.
const HELP = formatHelp();

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
  model: { model: string; endpoint: string };
  updateNotice?: string | null;
}): void {
  const { dir, id, gateLabel, files, resumed, model, updateNotice } = info;

  process.stdout.write(welcomeBanner(model));

  if (updateNotice !== undefined && updateNotice !== null) {
    process.stdout.write(`${updateNotice}\n`);
  }

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
    const web = buildWebGate("react", undefined, args.dir);

    return { accept: web.command, gateLabel: web.label };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  const { detectStack } = await import("./stack-detection");
  const {
    loadTsforgeConfig,
    resolveActivePacks,
    normalizeRuleOverrides,
    resolveProjectProfile,
  } = await import("./config/tsforge-config");

  const stackProfile = await detectStack(args.dir);
  const config = await loadTsforgeConfig(args.dir);
  const activePacks = resolveActivePacks(stackProfile.packs, config);
  const ruleOverrides = normalizeRuleOverrides(config);
  const profile = resolveProjectProfile(config);

  const auto = await buildGate(
    args.dir,
    activePacks,
    Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
    {
      enableTypeAware: profile === "strict",
      // "Green" should mean the strict floor AND the project's own tests pass —
      // not just that it type-checks and lints. discoverTestCommand appends them
      // only when the project actually has tests; --strict-floor-only opts out.
      includeTests: !args.strictFloorOnly,
    }
  );

  return { accept: auto.command, gateLabel: auto.label };
}

/** Interactive REPL: a persistent gate-anchored conversation. */
async function repl(args: ICliArgs): Promise<number> {
  // The active model comes from the registry (~/.tsforge/models.json) unless an
  // explicit TSFORGE_* env overrides it; `/model <name>` switches it live.
  const activeModel = await resolveActiveModel();
  const provider = makeProvider(activeModel.entry);
  let activeName = activeModel.name;

  warnDefaultModelOnRemote(activeModel.entry);

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
  // `let` so `/model` can refresh the gauge when switching to a model with a
  // different window. Per-entry contextWindow wins, then explicit env, then the
  // server's max_model_len, then a conservative fallback.
  let contextWindow =
    activeModel.entry.contextWindow ??
    envNumber("TSFORGE_CONTEXT_WINDOW") ??
    (await detectContextWindow(provider.config)) ??
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
    // --web pre-scaffolds the project above, so it gets the web gate/guidance
    // directly. EVERY OTHER interactive session offers `scaffold_web` (+ the
    // ui/routes tools that ride along) so the AGENT can decide mid-conversation
    // that a request is a from-scratch web app — this flag is what puts the tool
    // in the model's list; setSetupWeb() below only wires its callback.
    ...(args.web
      ? {
          // --web pre-scaffolds the app, so scaffold_web isn't needed — but the
          // build still needs scaffold_ui + scaffold_routes (+ add_dependency),
          // which `scaffoldUi: true` registers. Without this the web guidance
          // tells the model to call tools that aren't in its list and it deadlocks.
          scaffoldUi: true,
          guidance: webGuidance("react"),
          fix: buildWebFix("react"),
          incrementalCheck: buildWebTscCheck(),
        }
      : { scaffoldWeb: true, fix: buildCoreFix() }),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
    // Thinking OFF for interactive replies so they STREAM immediately instead of
    // stalling on a long hidden chain-of-thought (qwen-local defaults thinking on).
    // The session still flips thinking ON automatically while repairing gate errors.
    enableThinking: false,
  };

  let session = await Session.create(config);

  // A self-describing run-meta line at the top of the --log so the analyzer knows
  // which model / context window the metrics are against (the thread's advice:
  // many "model failures" are really quant/config failures — record the config).
  report({
    kind: "start",
    task: "session",
    message: `model ${modelInfo(provider.config).model} · context window ${contextWindow}`,
    model: modelInfo(provider.config).model,
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
      planMode,
      messages: [...session.messages],
    });
  };

  // "update available" notice: read from the local cache (no network on the hot
  // path) and refresh it in the background for next time. Gated to interactive,
  // non-CI sessions inside update-check, so eval/headless runs are unaffected.
  const updateNotice = await getUpdateNotice(currentVersion());

  refreshUpdateCacheInBackground();

  printHeader({
    dir: args.dir,
    id,
    gateLabel,
    files,
    resumed,
    model: modelInfo(provider.config),
    updateNotice,
  });

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

  // Explicit `--web` (no Q&A): the FIRST message is the build, so stage it
  // (plan+types → implement). Cleared after, so follow-ups are plain sends.
  let stagedWebPending = args.web && resumed === null;
  // Plan mode (`--plan` or toggled by /plan). For a staged web build it pauses
  // after the design phase to review the plan; for EVERYTHING else it is the
  // general read-only mode: the agent explores, asks clarifying questions, and
  // proposes a plan — only an explicit approval unlocks tools and implements.
  // A resumed session restores its saved mode (the read-only guarantee must
  // survive `--continue`).
  let planMode = args.plan || (resumed?.planMode ?? false);
  // True once a plan-mode exchange has happened, so a stray "approve" before any
  // discussion is just a message, not an approval.
  let planDiscussed = false;

  session.setPlanMode(planMode);

  // While set, the next user line is the plan-review reply ("approve", or edits to
  // fold into phase 2) — the design phase has run and is waiting at the checkpoint.
  let awaitingPlanApproval = false;

  const configureWeb = async (framework: WebFramework): Promise<void> => {
    process.stdout.write(
      `\n  ↳ scaffolding a ${frameworkLabel(framework)} project\n`
    );
    await setUpWebProject(args.dir, framework);
    session.setGate(buildWebGate(framework, undefined, args.dir).command);
    session.setFix(buildWebFix(framework));
    session.setIncrementalCheck(buildWebTscCheck());
    session.guide(webGuidance(framework));
    // A from-scratch web build legitimately needs many turns. Don't pin a low
    // ceiling here — the interactive session already rides the high runaway
    // backstop (interactiveBackstopTurns) and stops on the progress guards, so a
    // long, converging build is never cut off mid-write.
  };

  // The `scaffold_web` tool invokes this when the AGENT decides to build a web app
  // (the framework string is validated tool-side). `configureWeb` closes over the
  // mutable `session`, so this stays correct across `/clear`; re-applied below.
  const setupWeb = (framework: string): Promise<void> =>
    configureWeb(framework === "vanilla" ? "vanilla" : "react");

  session.setSetupWeb(setupWeb);

  // Last-turn summary, surfaced in the status line shown before each prompt.
  let lastTurns = 0;
  // Turns the last GREEN run took (the loop-efficiency signal shown in /metrics).
  let lastTurnsToGreen: number | null = null;
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

    lastStatus = "working"; // reflected live on the bar (● working) during the turn
    spinner.start();

    try {
      const result = await run({
        signal: active.signal,
        steer: () => pending.splice(0, pending.length),
      });

      lastTurns = result.turns;

      if (result.status === "done") {
        lastTurnsToGreen = result.turns;
      }

      lastElapsedMs = performance.now() - started;
      lastStatus = result.status;
    } finally {
      spinner.stop();
      active = null;
    }

    await persist();
  };

  const runSend = (line: string): Promise<void> =>
    drive((opts) => session.send(line, opts));

  // A from-scratch web build: stage it (plan + types, then implement) so the
  // model designs the type contract before writing UI — far less API invention.
  // The design phase gates on TYPES only (tsc + lint) so contract errors surface
  // early and small, not as a final avalanche. `withPlan` is the web flow's OWN
  // checkpoint (design writes types, so general read-only plan mode must be off).
  const runStagedBuild = (
    line: string,
    framework: WebFramework,
    withPlan: boolean
  ): Promise<void> =>
    withPlan
      ? runPlanned(line, framework)
      : drive((opts) =>
          session.buildStaged(line, opts, buildWebTypeGate(framework).command)
        );

  // Plan mode: run the design phase, then show the model's plan and PAUSE — the
  // next user line approves it (or edits it, folded into phase 2). The design runs
  // inside drive() (signal/steer/persist); the quick plan summary is captured for
  // the prompt that follows.
  const runPlanned = async (
    line: string,
    framework: WebFramework
  ): Promise<void> => {
    let plan = "";

    await drive(async (opts) => {
      const designed = await session.designBuild(
        line,
        opts,
        buildWebTypeGate(framework).command
      );

      if (designed.status !== "interrupted") {
        plan = await session.generatePlan();
      }

      return designed;
    });

    if (plan.length > 0) {
      process.stdout.write(
        `\n📋 PLAN — review, then type 'approve' to build, or describe changes:\n\n${plan}\n\n`
      );
      awaitingPlanApproval = true;
    }
  };

  const dispatch = async (line: string): Promise<void> => {
    // A reply to the plan checkpoint: "approve" (build as-planned) or any other
    // text = corrections folded into the implement phase. Either way phase 2 runs.
    if (awaitingPlanApproval) {
      awaitingPlanApproval = false;

      const approved = isApproval(line);
      const notes = approved ? "" : line;

      if (!approved) {
        process.stdout.write("  ↳ folding your changes into the build\n");
      }

      await drive((opts) => session.implementBuild(notes, opts));

      return;
    }

    // Explicit --web: the first message is a from-scratch build — stage it. The
    // staged flow has its OWN plan checkpoint (its design phase writes types),
    // so general read-only plan mode hands over to it here.
    if (stagedWebPending) {
      stagedWebPending = false;

      const withPlan = planMode;

      planMode = false;
      planDiscussed = false;
      session.setPlanMode(false);
      await runStagedBuild(line, "react", withPlan);

      return;
    }

    // GENERAL plan mode, approval: unlock the tools and implement the plan that
    // is already the latest assistant message. Only an explicit approval word
    // counts ("yes" may be answering one of the model's clarifying questions).
    if (planMode && planDiscussed && isPlanApproval(line)) {
      planMode = false;
      planDiscussed = false;
      session.setPlanMode(false);
      process.stdout.write("  ✓ plan approved — implementing\n");
      await drive((opts) => session.send(PLAN_APPROVED_NOTE, opts));

      return;
    }

    // GENERAL plan mode, discussion: the agent explores read-only, asks its
    // clarifying questions, and proposes/revises a plan. Stays in plan mode.
    if (planMode) {
      await runSend(line);
      planDiscussed = true;

      const last = session.messages.at(-1);
      const planned =
        last?.role === "assistant" && /^##\s*plan\b/im.test(last.content);

      process.stdout.write(
        planned
          ? "\n  📋 plan ready — reply to refine, or type 'approve' to implement\n"
          : "\n  (plan mode — reply to refine, or type 'approve' to implement)\n"
      );

      return;
    }

    // No up-front classifier: the AGENT decides. It calls `scaffold_web` itself
    // when the request is a from-scratch web app, and just answers/edits otherwise
    // (so "render a table in the CLI" is no longer mis-scaffolded as a Vite app).
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
        session.setSetupWeb(setupWeb);
        session.setPlanMode(planMode); // a /clear must not silently drop the mode
        planDiscussed = false;
        await persist();
        clearScreen(); // wipe the visible terminal + scrollback, not just the state
        process.stdout.write("conversation cleared\n");
        break;

      case "compact": {
        const { before, after } = await session.compact();

        await persist();
        process.stdout.write(`compacted ${before} → ${after} messages\n`);
        break;
      }

      case "plan":
        planMode = !planMode;
        planDiscussed = false;
        session.setPlanMode(planMode);
        process.stdout.write(
          planMode
            ? "plan mode ON — read-only: the agent explores, asks, and proposes " +
                "a plan; type 'approve' to implement\n"
            : "plan mode OFF\n"
        );
        break;

      case "gate":
        session.setGate(arg);
        process.stdout.write(
          arg.length > 0 ? `gate: ${arg}\n` : "gate cleared\n"
        );
        // Persist immediately so a `/gate` change survives even if the user quits
        // before the next send (persist otherwise only runs after a turn).
        await persist();
        break;

      case "review":
        await runReviewCommand(provider, args.dir, arg);
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
        const result = await runModelCommand({
          arg,
          provider,
          activeName,
          fallbackEntry: activeModel.entry,
          contextWindow,
        });

        activeName = result.activeName;
        contextWindow = result.contextWindow;
        break;
      }

      case "sessions":
        await printSessions(args.dir);
        break;

      case "memory": {
        if (arg.trim() === "forget") {
          await forgetMemory(args.dir);
          process.stdout.write("  memory cleared for this repo\n");
          break;
        }

        const ledger = await loadLedger(args.dir);

        if (ledger.entries.length === 0) {
          process.stdout.write("  no learned lessons yet\n");
          break;
        }

        const activeNames = new Set(
          activeRules(ledger, Date.now()).map((r) => r.name)
        );

        process.stdout.write(
          `  ${String(ledger.entries.length)} lesson(s), ${String(activeNames.size)} active (● fires · ○ still accruing):\n`
        );

        for (const entry of ledger.entries.slice(0, 20)) {
          const mark = activeNames.has(entry.name) ? "●" : "○";

          process.stdout.write(
            `    ${mark} ${entry.rule} · ${String(entry.hits)} hit(s)\n`
          );
        }

        process.stdout.write("  /memory forget to clear\n");
        break;
      }

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

      case "metrics": {
        const m = session.metrics;

        if (m.calls === 0) {
          process.stdout.write("  no model calls yet\n");
        } else {
          process.stdout.write(
            `  ${String(m.calls)} call(s) · ${String(m.promptTokens)} in / ${String(m.completionTokens)} out · ` +
              `${String(m.lastTokensPerSecond)} tok/s last · ${String(m.avgTokensPerSecond)} tok/s avg\n`
          );
        }

        process.stdout.write(turnsToGreenLine(lastTurnsToGreen));

        break;
      }

      default:
        process.stdout.write(`unknown command: ${line} (try /help)\n`);
    }

    return false;
  };

  // Current state as the status surface sees it — shared by the pinned bar and
  // the inline fallback so both show identical content.
  const statusInfo = (): IStatusInfo => ({
    model: modelInfo(provider.config).model,
    contextTokens: session.contextTokens,
    contextWindow,
    turns: lastTurns,
    elapsedMs: lastElapsedMs,
    status: lastStatus,
    scope: scopeLabel(session.scope) + (planMode ? " · PLAN" : ""),
    tokensPerSecond: session.metrics.lastTokensPerSecond,
  });

  // Pinned bottom status bar when we're on a real terminal; otherwise the bar is
  // inactive and `prompt()` falls back to the inline status line (pipes, --log).
  const statusBar = new StatusBar(process.stdout, true, true);

  // Repaint the bar on every spinner tick so tok/s and the context meter update
  // live mid-turn (both read live session state), not just at turn boundaries.
  spinner.onTick(() => {
    if (statusBar.active) {
      statusBar.update(statusInfo());
    }
  });

  process.stdout.on("resize", () => {
    statusBar.resize(statusInfo());
  });

  // Restore the terminal even on an unexpected exit (teardown is idempotent).
  process.on("exit", () => {
    statusBar.teardown();
  });

  // Wipe the visible terminal + scrollback (2J + 3J + home), re-pinning the status
  // bar around it so its scroll region stays correct. Used by /clear so the screen
  // is a clean slate, not just the conversation state.
  const clearScreen = (): void => {
    const wasActive = statusBar.active;

    if (wasActive) {
      statusBar.teardown();
    }

    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

    if (wasActive) {
      statusBar.install(statusInfo());
    }
  };

  // The prompt. With the bar pinned it repaints the bar and shows only the
  // input marker; otherwise it prints the inline status line above the marker.
  const prompt = (): void => {
    if (statusBar.active) {
      statusBar.update(statusInfo());
      process.stdout.write("\n› ");

      return;
    }

    process.stdout.write("\n");
    process.stdout.write(renderStatus(statusInfo()));
    process.stdout.write("› ");
  };

  await new Promise<void>((resolveLoop) => {
    let busy = false;
    let closed = false;
    let paletteOpen = false;

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

    // Open the interactive `/` command palette: pick a command from a navigable
    // list, then either run it (no-arg) or prefill the line so the user types the
    // argument. Cancel ⇒ back to a clean prompt. Only meaningful on a TTY.
    const openPalette = async (): Promise<void> => {
      paletteOpen = true;

      try {
        rl.write(null, { ctrl: true, name: "u" }); // clear the typed "/"

        const picked = await pickCommand(process.stdout.isTTY);

        // The palette ran on the alternate screen; exiting it restored the prompt
        // verbatim, so don't re-draw it (that left stray `›` lines). On cancel,
        // nothing to do; for an arg command, prefill so the user types the value.
        if (picked !== null) {
          if (takesArg(picked)) {
            rl.write(`${picked.name} `);
          } else {
            void runLine(picked.name);
          }
        }
      } finally {
        paletteOpen = false;
      }
    };

    // Press `/` on an empty line ⇒ open the palette. setImmediate lets readline
    // finish inserting the slash first, so `rl.line === "/"` confirms it's a fresh
    // command start (not a slash mid-text). No-op while busy or already open.
    if (process.stdin.isTTY) {
      emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", (str: string | undefined) => {
        if (busy || paletteOpen || str !== "/") {
          return;
        }

        setImmediate(() => {
          if (!busy && !paletteOpen && rl.line === "/") {
            void openPalette();
          }
        });
      });
    }

    // Event-driven (not for-await) so stdin is read DURING a run: a line typed
    // mid-run is queued to steer the next turn (or, if "/exit", aborts). This is
    // what makes it feel like a real harness — you can redirect without waiting.
    rl.on("line", (raw) => {
      const line = raw.trim();

      if (line.length === 0) {
        if (!busy) {
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
      statusBar.teardown();
      maybeFinish();
    });

    // Pin the bar before the first turn so it's visible while that turn streams.
    statusBar.install(statusInfo());

    if (args.task.length > 0) {
      void runLine(args.task); // sent as the first message; prompts when done
    } else {
      prompt();
    }
  });

  statusBar.teardown(); // belt-and-suspenders: restore the terminal on loop exit

  return 0;
}

/** `/review` in the REPL — review the current change and print findings. */
async function runReviewCommand(
  provider: OpenAICompatibleProvider,
  dir: string,
  base: string
): Promise<void> {
  process.stdout.write("reviewing the current change…\n");
  const report = await reviewChange(provider, dir, {
    ...(base.length > 0 ? { base } : {}),
    log: (m) => process.stdout.write(`  ↳ ${m}\n`),
  });

  process.stdout.write(`\n${formatReport(report)}\n`);
}

async function reviewMode(args: ICliArgs): Promise<number> {
  const { entry } = await resolveActiveModel();
  const report = await reviewChange(makeProvider(entry), args.dir, {
    ...(args.base.length > 0 ? { base: args.base } : {}),
    staged: args.staged,
    log: (m) => process.stdout.write(`  ↳ ${m}\n`),
  });

  process.stdout.write(`\n${formatReport(report)}\n`);

  // Exit non-zero when there are error-severity findings, so it's CI-usable.
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.review) {
    return reviewMode(args);
  }

  // A positional task with a scope + gate ⇒ one-shot; otherwise interactive.
  return isOneShot(args) ? runOnce(args) : repl(args);
}

// Direct run (`bun src/cli.ts`, dev). The published binary instead imports
// `main` from bin/tsforge.js, because `import.meta.main` is false when this
// module is imported rather than executed as the entry point.
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
