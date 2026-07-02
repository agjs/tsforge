#!/usr/bin/env bun
import { join, isAbsolute } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { formatHelp, takesArg } from "./cli/commands";
import { pickCommand } from "./render/command-menu";
import {
  pickFileInline,
  filterFiles,
  formatCompletionRows,
  shouldOpenAtPicker,
  type IPickerView,
} from "./render/file-menu";
import { listWorkspaceFiles, readFiles, runShellCommand } from "./lib/fs";
import { renderCheck } from "./browser";
import { composeMessage } from "./loop/prompt";
import {
  runTask,
  RUN_STATUS,
  Session,
  LedgerWriter,
  ledgerTypeFor,
  PLAN_APPROVED_NOTE,
  reviewChange,
  reviewRepair,
  formatReport,
  runGreenfield,
  prepareState,
  evaluateFeature,
  planFeatures,
  judgeFeature,
  negotiateContract,
  writeContract,
  contractEnabled,
  type IFeature,
  type IGreenfieldDeps,
  type Reporter,
  type SetupWebFn,
} from "./loop";
import { modelAgent } from "./agent";
import { buildAndPersistMap, mapStatus, forgetMap } from "./codebase";
import { parseEventLog, formatTrace } from "./eval";
import { loadRecipes, findRecipe } from "./config/recipes";
import {
  parseArgs,
  applyRecipe,
  isOneShot,
  scopeOf,
  WHOLE_REPO,
  type ICliArgs,
} from "./cli/args";
import { makeSpinner, spinnerPhase } from "./render/spinner";
import { validate } from "./validate";
import { isPolicyMode } from "./policy";
import { startEditor, type IEditorHandle } from "./editor";
import { renderEditor } from "./editor/view";
import { flags } from "./config/flags";
import {
  PROVIDER_LIMITS,
  PROVIDER_DEFAULTS,
  OpenAICompatibleProvider,
  type IOpenAICompatibleConfig,
} from "./inference";
import {
  resolveActiveModel,
  resolveModelByName,
  setActiveModel,
  loadModelsConfig,
  resolveApiKey,
  type IModelEntry,
} from "./models-config";
import {
  renderEvent,
  renderMessage,
  renderStatus,
  speakerLabel,
  indentBlock,
  BLOCK_INDENT,
  StatusBar,
  MIN_ROWS,
  welcomeBanner,
  STYLE,
  RESET,
  type IStatusInfo,
} from "./render";
import type { ITask } from "./spec";
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
  makeFileLinter,
  WEB_PACKS,
  type FileLinter,
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
export { parseArgs, applyRecipe, isOneShot, type ICliArgs } from "./cli/args";

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
 *  the model can't build until deps resolve. Returns the files actually written and
 *  whether install succeeded so the `scaffold_web` tool can account for the mutation
 *  and tell the model the truth (instead of always claiming "deps installed"). */
async function setUpWebProject(
  dir: string,
  framework: WebFramework,
  options: { signal?: AbortSignal } = {}
): Promise<{ files: readonly string[]; depsInstalled: boolean }> {
  const files = await scaffoldWeb(dir, framework);

  process.stdout.write(`  ↳ installing ${frameworkLabel(framework)}…\n`);

  const depsInstalled = await installWebDeps(dir, options);

  process.stdout.write(
    depsInstalled
      ? "  ↳ dependencies ready\n"
      : "  ⚠ dependency install failed — run `bun install` yourself\n"
  );

  return { files, depsInstalled };
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
    // Optional override only — guided decoding is auto-detected by endpoint
    // (local on, DeepSeek cloud off). Passed through when a model entry sets it.
    ...(entry.guidedDecoding === undefined
      ? {}
      : { guidedDecoding: entry.guidedDecoding }),
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

export { makeSpinner, spinnerPhase, type ISpinnerOut } from "./render/spinner";

const spinner = makeSpinner();

/** When the interactive REPL pins an editable input row, streamed output must be
 *  written THROUGH the StatusBar (so it scrolls in the region above the row and
 *  the cursor stays parked on the row). Null elsewhere ⇒ a plain stdout write. */
let interactiveStream: ((text: string) => void) | null = null;

const render: Reporter = (event) => {
  const phase = spinnerPhase(event);

  if (phase !== null) {
    spinner.setLabel(phase);
  }

  const out = renderEvent(event, { color: true });

  if (out.length > 0) {
    spinner.clear();

    if (interactiveStream !== null) {
      interactiveStream(out);
    } else {
      process.stdout.write(out);
    }
  }
};

/** Reporter that renders to the terminal AND, when `--log <file>` is set, appends
 *  the full event stream as JSONL (one event per line, timestamped) for later
 *  evaluation — the durable record of what the agent did: its reasoning, every
 *  file it wrote, the gate verdicts, and the loops it got stuck in. Append-only
 *  (NOT overwritten like the session JSON), and unredacted — it's an opt-in local
 *  debug artifact. Logging failures never break the session. */
function makeReporter(
  logFile: string,
  runId: string,
  sessionId?: string
): Reporter {
  if (logFile.length === 0) {
    return render;
  }

  const ledger = new LedgerWriter(logFile, runId, sessionId);

  return (event) => {
    render(event);

    const { kind, ...rest } = event;

    ledger.record(ledgerTypeFor(event), { kind, ...rest });
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

/** The model for a run: a recipe's named model (from ~/.tsforge/models.json) when
 *  set and known, else the active model. An unknown name warns and falls back. */
async function modelForRun(
  args: ICliArgs
): Promise<{ name: string; entry: IModelEntry }> {
  if (args.model.length > 0) {
    const cfg = await loadModelsConfig();
    const entry = cfg.models[args.model];

    if (entry !== undefined) {
      return { name: args.model, entry };
    }

    process.stdout.write(
      `  recipe model '${args.model}' not in models.json — using the active model\n`
    );
  }

  return resolveActiveModel();
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

  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");
  const { entry } = await modelForRun(args);
  const provider = makeProvider(entry);
  const report = makeReporter(logFile, "cli");
  const result = await runTask(task, args.dir, provider, {
    onEvent: report,
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
    ...(args.scout ? { scout: true } : {}),
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  // Optional post-green adversarial review + one repair cycle (reverts if it
  // breaks the gate). Only meaningful once the task is actually green.
  if (ok && args.withReview) {
    await reviewRepair(provider, args.dir, task, modelAgent(provider), {
      ...(args.base.length > 0 ? { base: args.base } : {}),
      onEvent: report,
    });
  }

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
    process.stdout.write(
      renderMessage(message, { color: true, speaker: model.model })
    );
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
): Promise<{ accept: string; gateLabel: string; lintFile?: FileLinter }> {
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
    ...(base.lintFile === undefined ? {} : { lintFile: base.lintFile }),
  };
}

/** The base gate: a resumed session's gate wins, then explicit `--accept`, then
 *  `--no-gate` (off), else tsforge's auto gate (strict-TS / project lint). */
async function baseGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<{ accept: string; gateLabel: string; lintFile?: FileLinter }> {
  if (resumed !== null) {
    const label = resumed.accept.length > 0 ? resumed.accept : "none";

    return { accept: resumed.accept, gateLabel: label };
  }

  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.web) {
    // The --web SCAFFOLD path is greenfield: tsforge writes the skeleton in its
    // own house style, so the web gate + web guidance deliberately stay on the
    // defaults and do NOT thread project `conventions` (which govern the core
    // brownfield path). Keeping both on house style avoids a gate/guidance
    // contradiction. See docs/harness-subsystems.md "setup / conventions".
    const web = buildWebGate("react", undefined, args.dir);

    // PER-WRITE lint moat: the web gate's eslint rules applied to each file as the
    // model writes it, so architecture/cast violations surface immediately instead
    // of as an end-of-turn pile-up.
    return {
      accept: web.command,
      gateLabel: web.label,
      lintFile: makeFileLinter("react", args.dir, WEB_PACKS),
    };
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
  const { resolveConventions } = await import("./infer-rules/conventions");

  const stackProfile = await detectStack(args.dir);
  const config = await loadTsforgeConfig(args.dir);
  const activePacks = resolveActivePacks(stackProfile.packs, config);
  const ruleOverrides = normalizeRuleOverrides(config);
  const profile = resolveProjectProfile(config);
  const conventions = resolveConventions(config.conventions);

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
      conventions,
    }
  );

  return {
    accept: auto.command,
    gateLabel: auto.label,
    lintFile: makeFileLinter(
      "core",
      args.dir,
      activePacks,
      Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
      conventions
    ),
  };
}

/** One-line nudge when the repo has no config yet — setup adapts the guardrails
 *  to this repo's conventions. Just a hint; never auto-runs. */
function maybePrintNoConfigHint(
  dir: string,
  resumed: ISessionRecord | null
): void {
  if (resumed === null && !existsSync(join(dir, "tsforge.config.json"))) {
    process.stdout.write(
      "No project config. Run tsforge setup (or /setup) to adapt guardrails to this repo.\n"
    );
  }
}

/** Initialize the REPL session: resolve model, gate, context window, and create
 *  the session object. Returns the session, provider, and config metadata.
 *  Extracted to reduce repl() cognitive complexity. */
async function initReplSession(args: ICliArgs): Promise<{
  session: Session;
  provider: OpenAICompatibleProvider;
  activeName: string;
  contextWindow: number;
  id: string;
  gateLabel: string;
  logFile: string;
  persist: () => Promise<void>;
  report: Reporter;
  resumed: ISessionRecord | null;
  files: string[];
  activeModelEntry: IModelEntry;
}> {
  const activeModel = await modelForRun(args);
  const provider = makeProvider(activeModel.entry);
  const activeName = activeModel.name;

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
  const { accept, gateLabel, lintFile } = await resolveGate(args, resumed);
  const files = resumed !== null ? resumed.files : scopeOf(args);
  const logFile = resolveLogPath(id, args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  // Scout seeds a one-shot drive-to-green run's first prompt; interactive sessions
  // gather context conversationally, so it doesn't apply here. Say so rather than
  // silently ignore the flag.
  if (args.scout) {
    process.stdout.write(
      '  ↳ note: --scout applies to one-shot runs (tsforge "task" --files … --scout); ignored in interactive mode\n'
    );
  }

  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  // Auto-compaction threshold (fraction of the window); session default 0.8.
  const autoCompactAt = envNumber("TSFORGE_COMPACT_AT");
  // The model's real context window: explicit env wins, else ask the server
  // (max_model_len), else a conservative fallback. Drives the status gauge AND
  // auto-compaction (the session compacts before a send once it nears the window).
  const contextWindow =
    activeModel.entry.contextWindow ??
    envNumber("TSFORGE_CONTEXT_WINDOW") ??
    (await detectContextWindow(provider.config)) ??
    32_768;
  const report = makeReporter(logFile, id, id);
  const config = {
    provider,
    cwd: args.dir,
    files,
    accept,
    contextWindow,
    report,
    // PER-WRITE lint moat (eslint rules per file as it's written), so violations
    // surface immediately instead of piling up at the end-of-turn gate.
    ...(lintFile === undefined ? {} : { lintFile }),
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
          incrementalCheck: buildWebTscCheck(args.dir),
        }
      : { scaffoldWeb: true, fix: buildCoreFix() }),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
    // `--policy-mode` (validated) overrides the config file's policy.mode.
    ...(isPolicyMode(args.policyMode) ? { policyMode: args.policyMode } : {}),
    // Thinking OFF for interactive replies so they STREAM immediately instead of
    // stalling on a long hidden chain-of-thought (qwen-local defaults thinking on).
    // The session still flips thinking ON automatically while repairing gate errors.
    enableThinking: false,
  };

  const session = await Session.create(config);

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
      planMode: false, // will be set by caller
      messages: [...session.messages],
    });
  };

  return {
    session,
    provider,
    activeName,
    contextWindow,
    id,
    gateLabel,
    logFile,
    persist,
    report,
    resumed,
    files,
    activeModelEntry: activeModel.entry,
  };
}

/** Interactive REPL: a persistent gate-anchored conversation. */
async function repl(args: ICliArgs): Promise<number> {
  const {
    session: initialSession,
    provider,
    activeName: initialActiveName,
    contextWindow: initialContextWindow,
    id,
    gateLabel,
    logFile,
    resumed,
    files,
    activeModelEntry,
  } = await initReplSession(args);

  let session = initialSession;
  let activeName = initialActiveName;
  let contextWindow = initialContextWindow;

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

  maybePrintNoConfigHint(args.dir, resumed);

  // Pin an editable input row only on a real TTY tall enough to host the bar.
  // In that mode readline does line-EDITING but must not RENDER (we paint the
  // row ourselves), so it gets a discard sink for output; otherwise it writes to
  // stdout as before (pipes, small terminals — behaviour unchanged).
  const useInputRow =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.stdout.rows >= MIN_ROWS;

  // In editor mode, do NOT create readline — the editor owns stdin exclusively.
  // In fallback mode (non-TTY or basicInput), readline is the only consumer.
  const useEditor = useInputRow && !flags.basicInput();

  const inputSink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });

  const rl = useEditor
    ? null
    : createInterface({
        input: process.stdin,
        output: useInputRow ? inputSink : process.stdout,
        terminal: true,
      });

  // Ctrl-C: while a turn is running, abort it and return to the prompt; while
  // idle at the prompt, quit. (readline emits SIGINT on the interface, so the
  // process isn't killed — we decide what it means.)
  let active: AbortController | null = null;
  // Lines typed WHILE a run is in flight — drained at each turn boundary to steer
  // the model (see Session.send `steer`), instead of blocking until the run ends.
  const pending: string[] = [];

  if (rl !== null) {
    rl.on("SIGINT", () => {
      if (active !== null) {
        active.abort();
      } else {
        rl.close();
      }
    });
  }

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

  const configureWeb = async (
    framework: WebFramework,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ files: readonly string[]; depsInstalled: boolean }> => {
    process.stdout.write(
      `\n  ↳ scaffolding a ${frameworkLabel(framework)} project\n`
    );

    const setup = await setUpWebProject(args.dir, framework, options);

    session.setGate(buildWebGate(framework, undefined, args.dir).command);
    session.setFix(buildWebFix(framework));
    session.setIncrementalCheck(buildWebTscCheck(args.dir));
    // The project only now has a tsconfig + node_modules — rebuild the TS service
    // so the per-write guard actually runs (it's skipped on a null service), and
    // switch the lint moat to the web rules so component-architecture /
    // no-jsx-computation / cast violations surface per file, not at the gate.
    await session.refreshTsService();
    session.setLintFile(makeFileLinter(framework, args.dir, WEB_PACKS));
    session.guide(webGuidance(framework));
    // A from-scratch web build legitimately needs many turns. Don't pin a low
    // ceiling here — the interactive session already rides the high runaway
    // backstop (interactiveBackstopTurns) and stops on the progress guards, so a
    // long, converging build is never cut off mid-write.

    return setup;
  };

  // The `scaffold_web` tool invokes this when the AGENT decides to build a web app
  // (the framework string is validated tool-side). `configureWeb` closes over the
  // mutable `session`, so this stays correct across `/clear`; re-applied below.
  const setupWeb: SetupWebFn = (framework, options) =>
    configureWeb(framework === "vanilla" ? "vanilla" : "react", options);

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

  // Free-text user sends route through here: resolve `@file` mentions to inlined
  // contents (composeMessage) before handing the message to the session. The
  // plan-approval / staged-build sends call session.send directly and are not
  // touched, so only ordinary messages get mention expansion.
  const runSend = (line: string): Promise<void> =>
    drive(async (opts) =>
      session.send(await composeMessage(args.dir, line), opts)
    );

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
          session.buildStaged(
            line,
            opts,
            buildWebTypeGate(framework, undefined, args.dir).command
          )
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
        buildWebTypeGate(framework, undefined, args.dir).command
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
        // Rebuild the session with the current state (config is not reused;
        // repl's /clear creates a fresh Session.create call)
        session = await Session.create({
          provider,
          cwd: args.dir,
          files: session.scope,
          accept: session.gate,
          contextWindow,
          report: makeReporter(logFile, id, id),
          enableThinking: false,
        });
        session.setSetupWeb(setupWeb);
        session.setPlanMode(planMode); // a /clear must not silently drop the mode
        planDiscussed = false;
        await persist();
        clearScreen(); // wipe the visible terminal + scrollback, not just the state
        process.stdout.write("conversation cleared\n");
        break;

      case "compact": {
        // Compaction is a full model round-trip (can take many seconds). Drive the
        // SAME live-activity path a turn uses: lastStatus → "● working" on the bar,
        // spinner.start() runs the tick timer whose onTick repaints the bar with the
        // "⠋ compacting · Ns" activity segment (the inline spinner is suppressed in
        // the REPL, so the bar IS the loader). ALWAYS restore + stop, even on a
        // provider error, so the prompt comes back clean and idle.
        lastStatus = "working";
        spinner.start();
        spinner.setLabel("compacting");

        try {
          const { before, after } = await session.compact();

          await persist();
          process.stdout.write(`compacted ${before} → ${after} messages\n`);
        } finally {
          spinner.stop();
          lastStatus = "ready";
        }

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

      case "map":
        await runMapCommand(args.dir, arg);
        break;

      case "trace":
        await runTraceCommand(arg, logFile);
        break;

      case "setup": {
        const { runSetup } = await import("./setup/run-setup");

        // runSetup prints its own apply/cancel summary — don't add a second,
        // possibly-misleading line (it would claim success even on cancel).
        await runSetup({
          cwd: args.dir,
          yes: false,
          color: process.stdout.isTTY,
        });
        break;
      }

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
          fallbackEntry: activeModelEntry,
          contextWindow,
        });

        activeName = result.activeName;
        contextWindow = result.contextWindow;
        // Keep auto-compaction in sync with the new model's window — not just the
        // status bar. Otherwise a swap to a smaller model compacts too late.
        session.setContextWindow(contextWindow);
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
    ...(spinner.frameLabel().length > 0
      ? { activity: spinner.frameLabel() }
      : {}),
  });

  // Pinned bottom status bar when we're on a real terminal; otherwise the bar is
  // inactive and `prompt()` falls back to the inline status line (pipes, --log).
  const statusBar = new StatusBar(process.stdout, true, true, useInputRow);

  // Set once the multi-line editor is created (it lives in a nested scope); the
  // resize handler below calls it so the editor re-wraps/re-windows at the new
  // size instead of clipping the current line at its pre-resize dimensions.
  let resizeEditor: ((columns: number, rows: number) => void) | null = null;

  // Each agent turn renders as a "▌ <model>" block with its body indented under the
  // label (mirrors the user block). The label is emitted once, on the turn's first
  // streamed output; `agentTurnOpen` is reset at the start of every runLine.
  let agentTurnOpen = false;
  let agentAtLineStart = true;

  // Indent each streamed line under the agent label. Stateful so indentation is
  // correct even when a line is split across chunks (tokens). ANSI codes carry no
  // newlines, so they're treated as ordinary characters and never mis-indented.
  const indentAgentChunk = (text: string): string => {
    let out = "";

    for (const ch of text) {
      if (agentAtLineStart && ch !== "\n") {
        out += BLOCK_INDENT;
        agentAtLineStart = false;
      }

      out += ch;

      if (ch === "\n") {
        agentAtLineStart = true;
      }
    }

    return out;
  };

  // Route streamed agent output through the bar so it scrolls above the pinned
  // input row; cleared on loop exit so later/headless writes go straight to stdout.
  if (useInputRow) {
    interactiveStream = (text): void => {
      if (!agentTurnOpen) {
        agentTurnOpen = true;
        agentAtLineStart = true;
        statusBar.writeStream(
          `\n${speakerLabel(statusInfo().model, false, true)}\n`
        );
      }

      statusBar.writeStream(indentAgentChunk(text));
    };
  }

  // Start a fresh agent block for each turn (the label re-emits on its first output).
  const beginAgentTurn = (): void => {
    agentTurnOpen = false;
  };

  // Mirror readline's buffer onto the input row after each keypress. setImmediate
  // lets readline update rl.line/rl.cursor first (it processes the key async).
  const syncInput = (): void => {
    if (useInputRow && rl !== null) {
      setImmediate(() => {
        statusBar.setInput(rl.line, rl.cursor);
      });
    }
  };

  // Echo a CLI-side line (queued-steer notice, etc.) into the scroll region so it
  // doesn't clobber the pinned input row; plain write when the row isn't active.
  const echo = (text: string): void => {
    if (useInputRow) {
      statusBar.writeStream(text);
    } else {
      process.stdout.write(text);
    }
  };

  // In the interactive REPL a readline prompt owns stdin for the WHOLE session, so
  // the spinner's carriage-return inline write would clobber whatever the user is
  // typing mid-turn — regardless of whether the pinned bar is active. So suppress
  // the inline write unconditionally here: when the bar is up (≥5 rows) it shows the
  // activity itself via statusInfo; on a sub-5-row TTY there's simply no inline
  // spinner (correct — better silent than corrupting the input line). The default
  // `() => true` gate still applies to any non-interactive spinner use.
  spinner.setInlineGate(() => false);

  // A drag-resize fires SIGWINCH continuously while the terminal reflows. Painting
  // the bar into that moving target strands copies of it (the multi-bar / stray-rule
  // mess a circular corner-drag produced). So we DEBOUNCE: while resizes are still
  // arriving we suppress ALL bar repaints (spinner ticks included) and repaint once,
  // cleanly, only after the size settles (~120ms of quiet).
  const RESIZE_SETTLE_MS = 120;
  let resizing = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Repaint the bar on every spinner tick so tok/s and the context meter update
  // live mid-turn (both read live session state) — but NOT during a resize storm.
  spinner.onTick(() => {
    if (statusBar.active && !resizing) {
      statusBar.update(statusInfo());
    }
  });

  // Named so it can be detached on loop exit (an anonymous listener on the
  // global process.stdout would pin the whole REPL closure for the process
  // lifetime). columns/rows are typed `number` here, so no nullish guard is
  // needed; the editor's resize ignores non-positive values regardless.
  const handleResize = (): void => {
    resizing = true;
    statusBar.pauseForResize(); // buffer streamed output; draw nothing mid-storm

    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizing = false;
      resizeTimer = null;
      statusBar.resize(statusInfo());
      // The editor wraps/windows at the dimensions it was created with; without
      // this it keeps using the pre-resize size and can clip the current line.
      resizeEditor?.(process.stdout.columns, process.stdout.rows);
      statusBar.flushStream(); // replay buffered output into the settled region
    }, RESIZE_SETTLE_MS);
  };

  process.stdout.on("resize", handleResize);

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

  // The prompt. With the editable input row pinned it's always visible, so we
  // just repaint the bar + row; with the bar (no input row) it shows the inline
  // marker; otherwise it prints the inline status line above the marker.
  const prompt = (): void => {
    if (useInputRow) {
      if (rl !== null) {
        statusBar.setInput(rl.line, rl.cursor);
      }

      statusBar.update(statusInfo());

      return;
    }

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
    let editorHandle: IEditorHandle | null = null;
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

    // Submit a line of input: check if busy/pending, echo it, handle /exit, or run it.
    const submitLine = (raw: string): void => {
      const line = raw.trim();

      if (line.length === 0) {
        if (!busy) {
          prompt();
        }

        return;
      }

      // readline's output is sinked in input-row mode, so the submitted line is
      // never echoed to scrollback — record it ourselves so the transcript reads
      // naturally above the (now-cleared) input row.
      if (useInputRow) {
        echo(
          `\n${speakerLabel("you", true, true)}\n` +
            `${STYLE.brand}${indentBlock(line)}${RESET}\n`
        );
      }

      if (busy) {
        if (line === "/exit" || line === "/quit") {
          active?.abort();

          if (rl !== null) {
            rl.close();
          }

          if (editorHandle !== null) {
            editorHandle.close();
          }
        } else {
          pending.push(line);
          echo("  ↳ queued (steers the next turn)\n");
        }

        return;
      }

      void runLine(line);
    };

    // Handle one idle line (slash command or a message), then any queued follow-up.
    const runLine = async (line: string): Promise<void> => {
      busy = true;
      beginAgentTurn(); // the agent's response opens a fresh "▌ <model>" block

      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            if (rl !== null) {
              rl.close();
            }

            return;
          }
        } else {
          await dispatch(line);
        }
      } catch (err) {
        // A command/turn that throws (e.g. a provider error mid-/compact) must NOT
        // escape: runLine is invoked fire-and-forget (`void runLine(...)`), so an
        // unhandled rejection would terminate the whole REPL — which read as "the
        // CLI just exits". Surface the error and fall through to re-prompt instead.
        spinner.stop(); // belt-and-suspenders: clear any spinner the failed path left running
        echo(`\n⚠ ${err instanceof Error ? err.message : String(err)}\n`);
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

    // Helper: repaint the editor buffer to the status bar after palette insertion.
    const repaintEditor = (handle: IEditorHandle): void => {
      const { line, col } = handle.getBuffer().getCursor();
      const lines = handle.getBuffer().getText().split("\n");

      const frame = renderEditor(
        {
          lines,
          cursorLine: line,
          cursorCol: col,
        },
        {
          columns: process.stdout.columns,
          // Mirror the editor controller's own repaint window (rows minus the bar
          // block) so wrapping/windowing matches.
          maxRows: Math.max(1, process.stdout.rows - 3),
          color: true,
        }
      );

      // Repaint the editor block IN the pinned live region (setEditor), NOT via
      // writeStream — writeStream treats its argument as conversation content, so
      // it would strand the editor frame in scrollback (a leftover "/" per palette
      // open). This mirrors the editor's renderEditor→setEditor callback.
      statusBar.setEditor(
        frame.frame.split("\n"),
        frame.cursorRow,
        frame.cursorCol
      );
    };

    // Open the interactive `/` command palette: pick a command from a navigable
    // list, then either run it (no-arg) or prefill the line so the user types the
    // argument. Cancel ⇒ back to a clean prompt. Only meaningful on a TTY.
    const openPalette = async (): Promise<void> => {
      paletteOpen = true;
      // Suspend the editor's stdin ownership so the palette's keypress loop owns
      // input (see openFilePicker). Resumed in finally.
      editorHandle?.suspend();

      try {
        const picked = await pickCommand(process.stdout.isTTY);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().setText("");

            if (takesArg(picked)) {
              // Prefill "<cmd> " so the user types the argument next.
              editorHandle.getBuffer().insert(`${picked.name} `);
              repaintEditor(editorHandle);
            } else {
              // No-arg command: run it and leave the input EMPTY. Inserting the
              // name would linger in the buffer and reappear on the next keystroke
              // (the "/clear" ghost after the screen is cleared).
              repaintEditor(editorHandle);
              void runLine(picked.name);
            }
          } else if (rl !== null) {
            rl.write(null, { ctrl: true, name: "u" }); // clear the typed "/"

            if (takesArg(picked)) {
              rl.write(`${picked.name} `);
            } else {
              void runLine(picked.name);
            }
          }
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        if (useInputRow) {
          statusBar.update(statusInfo());

          if (rl !== null) {
            syncInput();
          }
        }
      }
    };

    // Open the interactive `@` file picker: a compact dropdown rendered INLINE just
    // above the input row (the conversation stays visible — no alternate screen),
    // recency-ordered, type to fuzzy-filter. The buffer keeps its `@`; the live
    // query is echoed onto the input row for feedback (it isn't in readline's/editor's
    // buffer — the picker owns input). On select, the full path is appended after
    // the `@`; at send time `@path` expands to the file's contents (see runSend).
    const openFilePicker = async (): Promise<void> => {
      paletteOpen = true;
      // In editor mode the editor owns stdin via a `data` listener; suspend it so
      // the inline picker's own `keypress` loop isn't fighting the editor for every
      // keystroke (both would otherwise consume the same input). Resumed in finally.
      editorHandle?.suspend();

      const base =
        editorHandle !== null
          ? editorHandle.getBuffer().getText()
          : rl !== null
            ? rl.line
            : ""; // text up to and including the just-typed `@`

      const view: IPickerView = {
        render: (query, items, selected): void => {
          const rows = formatCompletionRows(
            items,
            selected,
            process.stdout.columns,
            process.stdout.isTTY
          );

          statusBar.setInput(`${base}${query}`, base.length + query.length);
          statusBar.setOverlay(rows, statusInfo());
        },
        close: (): void => {
          statusBar.clearOverlay(statusInfo());
        },
      };

      try {
        const files = await listWorkspaceFiles(args.dir);
        const picked = await pickFileInline(files, view);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().insert(`${picked} `);
            repaintEditor(editorHandle);
          } else if (rl !== null) {
            rl.write(`${picked} `);
          }
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        if (useInputRow) {
          statusBar.update(statusInfo());

          if (rl !== null) {
            syncInput();
          }
        }
      }
    };

    // `/` on an empty line opens the palette; `@` at a word boundary opens the file
    // picker. The editor handles these internally (via openPalette/openFilePicker deps);
    // readline mode uses keypress detection. The shared paletteOpen guard keeps the
    // two overlays mutually exclusive. No-op while busy.

    if (process.stdin.isTTY && !useEditor && !flags.basicInput()) {
      // Only set up keypress detection for readline mode (not editor mode).
      emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", (str: string | undefined) => {
        syncInput(); // keep the pinned input row in sync as the user types

        if (busy || paletteOpen) {
          return;
        }

        if (str === "/" && rl !== null) {
          setImmediate(() => {
            if (!busy && !paletteOpen && rl.line === "/") {
              void openPalette();
            }
          });
        } else if (str === "@" && useInputRow && rl !== null) {
          // The inline dropdown renders above the input row, so it needs that row
          // (a tall-enough TTY). Without it we skip the picker — `@path` typed by
          // hand still expands at send time (composeMessage), just no live popup.
          setImmediate(() => {
            if (
              !busy &&
              !paletteOpen &&
              shouldOpenAtPicker(rl.line, rl.cursor)
            ) {
              void openFilePicker();
            }
          });
        }
      });
    }

    // Event-driven (not for-await) so stdin is read DURING a run: a line typed
    // mid-run is queued to steer the next turn (or, if "/exit", aborts). This is
    // what makes it feel like a real harness — you can redirect without waiting.
    // When the editor is active, submitLine is wired via onSubmit; otherwise it's
    // called here from readline. Crucially: the editor owns stdin exclusively in
    // editor mode, and readline is NOT created in that case.
    if (useEditor) {
      // Editor-native `@`-completion: preload the workspace file list once, then
      // filter it synchronously as the user types. The dropdown is painted ABOVE
      // the editor block (not the readline input row), so it can't fight the editor
      // for the cursor — the cause of the earlier display corruption.
      let completionFiles: readonly string[] = [];

      void listWorkspaceFiles(args.dir).then((files) => {
        completionFiles = files;
      });

      const editorCompletion = {
        items: (query: string): readonly string[] =>
          filterFiles(completionFiles, query),
        render: (items: readonly string[], selected: number): void => {
          statusBar.setEditorOverlay(
            formatCompletionRows(
              items,
              selected,
              process.stdout.columns,
              process.stdout.isTTY
            )
          );
        },
        clear: (): void => {
          statusBar.clearEditorOverlay();
        },
      };

      editorHandle = startEditor({
        stdin: {
          on: (event: string, cb: (data: string) => void) => {
            process.stdin.on(event, cb);
          },
          removeListener: (event: string, cb: (data: string) => void) => {
            process.stdin.removeListener(event, cb);
          },
          setRawMode: (mode: boolean) => {
            process.stdin.setRawMode(mode);
          },
          resume: () => {
            process.stdin.resume();
          },
          // The editor does string ops per chunk; without UTF-8 encoding,
          // process.stdin emits Buffers and the first keypress crashes.
          setEncoding: () => {
            process.stdin.setEncoding("utf8");
          },
        },
        out: (s: string) => {
          statusBar.writeStream(s);
        },
        // Multi-row editor rendering callback: paints to the pinned input area
        renderEditor: (
          lines: string[],
          cursorRow: number,
          cursorCol: number
        ) => {
          statusBar.setEditor(lines, cursorRow, cursorCol);
        },
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        openPalette,
        openFilePicker,
        completion: editorCompletion,
      });

      resizeEditor = (columns, rows): void => {
        editorHandle?.resize(columns, rows);
      };

      editorHandle.onSubmit(submitLine);
      editorHandle.onInterrupt(() => {
        if (active === null) {
          closed = true;
          editorHandle?.close();
          maybeFinish();
        } else {
          active.abort();
        }
      });
      editorHandle.onExit(() => {
        closed = true;
        editorHandle?.close();
        maybeFinish();
      });
    } else if (rl !== null) {
      rl.on("line", submitLine);
    }

    rl?.on("close", () => {
      closed = true;
      editorHandle?.close();
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
  process.stdout.off("resize", handleResize); // don't pin the REPL closure
  interactiveStream = null; // later/headless writes go straight to stdout again

  return 0;
}

/** `/map [status|forget]` (REPL) and `tsforge map` — build/inspect the workspace
 *  map. The built map primes future sessions (and a `/clear`). */
async function runMapCommand(dir: string, sub: string): Promise<void> {
  if (sub === "status") {
    process.stdout.write(`${await mapStatus(dir)}\n`);

    return;
  }

  if (sub === "forget") {
    const had = await forgetMap(dir);

    process.stdout.write(
      had ? "workspace map deleted\n" : "no map to delete\n"
    );

    return;
  }

  if (sub.length > 0) {
    process.stdout.write(
      `unknown map subcommand: ${sub} (use 'status', 'forget', or nothing to build)\n`
    );

    return;
  }

  process.stdout.write("building workspace map…\n");

  try {
    const map = await buildAndPersistMap(dir);

    process.stdout.write(
      map === null
        ? "no tsconfig.json — nothing to map (the map is for TypeScript projects)\n"
        : `mapped ${map.meta.totalFiles} files, ${map.hubs.length} hubs. Primes new sessions (/clear to apply now).\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(`map failed: ${message}\n`);
  }
}

/** `/review` in the REPL — review the current change and print findings. */
async function runReviewCommand(
  provider: OpenAICompatibleProvider,
  dir: string,
  base: string
): Promise<void> {
  process.stdout.write("reviewing the current change…\n");

  // Guard the REPL: a review error (git/fs/model) must not crash the session.
  try {
    const report = await reviewChange(provider, dir, {
      ...(base.length > 0 ? { base } : {}),
      log: (m) => process.stdout.write(`  ↳ ${m}\n`),
    });

    process.stdout.write(`\n${formatReport(report)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(`\nreview failed: ${message}\n`);
  }
}

/** Run the auto/explicit gate ONCE and return its distinct failing rule ids, so a
 *  gate-aware review skips what the gate already covers. Green/no-gate → []. */
async function gateFailingRules(args: ICliArgs): Promise<string[]> {
  // Running the gate can throw (missing deps, a broken gate command, env issues).
  // A gate-aware review is an enhancement, never a hard dependency — on any failure
  // fall back to a full review instead of crashing the command.
  try {
    const gate = await resolveGate(args, null);

    if (gate.accept.length === 0) {
      return [];
    }

    const task: ITask = { id: "review", accept: gate.accept, files: [] };
    const result = await validate(task, args.dir);

    if (result.passed) {
      return [];
    }

    const rules = new Set<string>();

    for (const error of result.errors) {
      if (typeof error.rule === "string" && error.rule.length > 0) {
        rules.add(error.rule);
      }
    }

    return [...rules];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(
      `gate: couldn't run the gate (${message}) — falling back to full review\n`
    );

    return [];
  }
}

async function reviewMode(args: ICliArgs): Promise<number> {
  const { entry } = await resolveActiveModel();
  const rules = args.withGate ? await gateFailingRules(args) : [];

  if (args.withGate) {
    process.stdout.write(
      rules.length > 0
        ? `gate: ${rules.length} failing rule(s) — review will skip what they cover\n`
        : "gate: green — full functional review\n"
    );
  }

  const report = await reviewChange(makeProvider(entry), args.dir, {
    ...(args.base.length > 0 ? { base: args.base } : {}),
    staged: args.staged,
    ...(rules.length > 0 ? { gateFailingRules: rules } : {}),
    log: (m) => process.stdout.write(`  ↳ ${m}\n`),
  });

  process.stdout.write(`\n${formatReport(report)}\n`);

  // Exit non-zero when there are error-severity findings, so it's CI-usable.
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

async function mapMode(args: ICliArgs): Promise<number> {
  await runMapCommand(args.dir, args.task);

  return 0;
}

/** `tsforge setup` — the onboarding wizard that infers + writes project
 *  conventions. `--yes` writes the recommendations non-interactively. */
async function setupMode(args: ICliArgs): Promise<number> {
  const { runSetup } = await import("./setup/run-setup");

  return runSetup({
    cwd: args.dir,
    yes: args.setupYes,
    color: process.stdout.isTTY,
  });
}

/** `tsforge recipes` — list the recipes discovered for this repo. */
async function recipesMode(args: ICliArgs): Promise<number> {
  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );

  if (recipes.length === 0) {
    process.stdout.write(
      "no recipes found — add .tsforge/recipes/<id>.json (see the docs)\n"
    );

    return 0;
  }

  process.stdout.write("Recipes:\n");

  for (const recipe of recipes) {
    const desc =
      recipe.description === undefined ? "" : ` — ${recipe.description}`;

    process.stdout.write(`  ${recipe.id}${desc}\n`);
  }

  return 0;
}

/** Resolve `--recipe`/`tsforge run <id>` and overlay it onto args. Returns an
 *  exit code to abort on (unknown id), or null to continue dispatching. */
async function applyRecipeArg(args: ICliArgs): Promise<number | null> {
  if (args.recipe.length === 0) {
    return null;
  }

  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );
  const recipe = findRecipe(recipes, args.recipe);

  if (recipe === undefined) {
    process.stdout.write(
      `unknown recipe: ${args.recipe} — run \`tsforge recipes\` to list them\n`
    );

    return 1;
  }

  applyRecipe(args, recipe);
  process.stdout.write(`using recipe '${recipe.id}'\n`);

  return null;
}

/** Resolve the newest `--log` JSONL under ~/.tsforge/logs, or "" if none. */
async function newestLogFile(): Promise<string> {
  try {
    // Filenames are ISO-timestamp-prefixed, so lexicographic sort = chronological.
    const names = (await readdir(logsDir()))
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    const latest = names.at(-1);

    return latest === undefined ? "" : join(logsDir(), latest);
  } catch {
    return "";
  }
}

/** A user-supplied log path resolved against cwd, or "" when none was given. */
function resolveLogArg(arg: string): string {
  if (arg.length === 0) {
    return "";
  }

  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}

/** `tsforge trace [logfile]` / `/trace` — summarize a `--log` run: model/tool
 *  calls, policy decisions (allow/ask/deny by risk), gate verdicts, and
 *  turns-to-green. Deterministic, no model call. With no path it prefers `prefer`
 *  (the live session log) and falls back to the newest log on disk. */
async function runTraceCommand(arg: string, prefer = ""): Promise<number> {
  let file = resolveLogArg(arg);

  if (file.length === 0) {
    file = prefer;
  }

  if (file.length === 0) {
    file = await newestLogFile();
  }

  if (file.length === 0) {
    process.stdout.write(
      "no log to analyze — run with --log first, or pass a path\n"
    );

    return 1;
  }

  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  const events = parseEventLog(text);

  if (events.length === 0) {
    process.stdout.write(`no events parsed from ${file}\n`);

    return 1;
  }

  process.stdout.write(`trace of ${file}\n\n${formatTrace(events)}\n`);

  return 0;
}

async function traceMode(args: ICliArgs): Promise<number> {
  return runTraceCommand(args.task);
}

/** Concatenate the editable scope into a single, size-capped code window for the
 *  feature judge — the BUILT ARTIFACT only (design-rule #2: no tool trace). */
async function scopeCode(dir: string, files: string[]): Promise<string> {
  const views = await readFiles(dir, files);
  const joined = views.map((v) => `// ${v.path}\n${v.content}`).join("\n\n");
  const CAP = 16000;

  return joined.length > CAP ? `${joined.slice(0, CAP)}\n…[truncated]` : joined;
}

/** Build the greenfield deps: implement one feature with the work model (reusing
 *  the headless runTask driver against the build gate), then evaluate it through
 *  the layered stack — deterministic gate, optional browser steps, reject-by-
 *  default judge on the EVALUATOR model (which only ever sees the built code). */
function greenfieldDeps(
  args: ICliArgs,
  work: OpenAICompatibleProvider,
  evaluator: OpenAICompatibleProvider,
  scope: string[],
  report: Reporter
): IGreenfieldDeps {
  const featureTask = (feature: IFeature): ITask => ({
    id: feature.id,
    intent: `${args.task}\n\nImplement this feature: ${feature.desc}`,
    accept: args.accept,
    files: scope,
    context: [],
  });

  // Optional pre-build contract negotiation (EXPERIMENTAL, gated by
  // TSFORGE_CONTRACT). When on, the generator + evaluator agree a contract first
  // and it anchors the implement prompt.
  const contractPrefix = async (feature: IFeature): Promise<string> => {
    if (!contractEnabled()) {
      return "";
    }

    const result = await negotiateContract(work, evaluator, feature);

    await writeContract(args.dir, feature, result);
    report({
      kind: "fix",
      task: "greenfield",
      message: `contract '${feature.id}': ${result.agreed ? "agreed" : "no agreement"} after ${result.rounds} round(s)`,
    });

    // Don't claim agreement the negotiation didn't reach — an unagreed contract
    // is the generator's best proposal, labelled honestly so the build prompt
    // doesn't assert a safety guarantee that isn't there.
    const heading = result.agreed
      ? "Agreed build contract"
      : "Proposed build contract (negotiation did not converge)";

    return `${heading}:\n${result.contract}\n\n`;
  };

  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");

  return {
    implement: async (feature) => {
      const prefix = await contractPrefix(feature);
      const base = featureTask(feature);

      await runTask(
        { ...base, intent: `${prefix}${base.intent ?? ""}` },
        args.dir,
        work,
        {
          onEvent: report,
          // The global gate is often already green between features, so don't
          // bail RED-first — the model must still build this feature.
          requireRed: false,
          ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
          ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
        }
      );
    },
    evaluate: (feature) =>
      evaluateFeature(feature, {
        gate: async () => {
          const v = await validate(featureTask(feature), args.dir);

          return { passed: v.passed, output: v.output };
        },
        // The browser layer runs the feature's steps only when a render target
        // (`--browser <html>`) is configured; otherwise it's a no-op skip (the
        // build gate already browser-smokes web apps).
        browser: async () =>
          args.browser.length > 0
            ? renderCheck({
                // Resolve a relative --browser against the RUN dir (--dir), not the
                // launcher's cwd — greenfield checks run in-process, unlike the
                // normal gate which already runs inside --dir.
                file: isAbsolute(args.browser)
                  ? args.browser
                  : join(args.dir, args.browser),
                smoke: true,
                ...(feature.steps === undefined
                  ? {}
                  : { steps: feature.steps }),
              })
            : { ok: true, errors: [], skipped: true },
        judge: async () =>
          judgeFeature(evaluator, {
            feature: feature.desc,
            code: await scopeCode(args.dir, scope),
          }),
      }),
  };
}

/** A `--notify` hook is bounded: an unattended/cron run must not hang forever on a
 *  notifier that wedges (a `curl` to a dead host with no `--max-time`, a stray
 *  `read` on stdin). 30s is generous for a real ping yet always lets the run end. */
const NOTIFY_TIMEOUT_MS = 30_000;

/** Run the `--notify` shell command (if any) with the run outcome in
 *  $TSFORGE_STATUS — a ping for unattended/cron runs. Best-effort: a failing,
 *  missing, OR HANGING notifier never changes the run's exit code, because it
 *  routes through the shared runner (uniform kill-timeout) and is bounded. */
export async function runNotify(
  cwd: string,
  cmd: string,
  status: string,
  timeoutMs: number = NOTIFY_TIMEOUT_MS
): Promise<void> {
  if (cmd.length === 0) {
    return;
  }

  try {
    await runShellCommand(cwd, cmd, {
      timeoutMs,
      env: { ...process.env, TSFORGE_STATUS: status },
      onChunk: (text) => process.stdout.write(text),
    });
  } catch {
    // A broken notifier must not break the run.
  }
}

/** `tsforge --greenfield "<goal>"` / a recipe with `mode: "greenfield"`: plan a
 *  feature checklist (planner model), then drive it to all-green one feature at a
 *  time on the existing gate + browser + judge stack, persisting state so a long
 *  run resumes. Roles route to separate models when configured, else all share
 *  the active model. */
async function greenfieldMode(args: ICliArgs): Promise<number> {
  if (args.task.length === 0) {
    process.stdout.write(
      'missing build goal — usage: tsforge --greenfield "build a kanban app"\n'
    );

    return 1;
  }

  if (args.accept.length === 0) {
    process.stdout.write(
      "greenfield needs a build gate — pass --accept '<cmd>' or set `gate` in the recipe\n"
    );

    return 1;
  }

  // Each role falls back to the recipe's `model` (then the active model), per the
  // recipe contract — a recipe that sets only `model` must route ALL roles there,
  // not just the work role.
  const roleName = (specific: string): string =>
    specific.length > 0 ? specific : args.model;
  const planner = makeProvider(
    (await resolveModelByName(roleName(args.plannerModel))).entry
  );
  const work = makeProvider(
    (await resolveModelByName(roleName(args.workModel))).entry
  );
  const evaluator = makeProvider(
    (await resolveModelByName(roleName(args.evaluatorModel))).entry
  );

  const state = await prepareState(args.dir, args.task, (goal) =>
    planFeatures(planner, goal)
  );

  if (state === null) {
    process.stdout.write("planner produced no features — nothing to build\n");

    return 1;
  }

  const report = makeReporter(
    resolveLogPath("greenfield", args.log),
    "greenfield"
  );
  const scope = scopeOf(args);
  const result = await runGreenfield(
    args.dir,
    state,
    greenfieldDeps(args, work, evaluator, scope, report),
    { onEvent: report }
  );

  const done = result.features.filter((f) => f.passes).length;

  process.stdout.write(
    `\n${result.status === "done" ? "✓ all features verified" : `✗ stuck on '${result.stuckFeature ?? "?"}'`} (${done}/${result.features.length})\n`
  );

  await runNotify(
    args.dir,
    args.notify,
    `greenfield ${result.status} ${done}/${result.features.length}`
  );

  return result.status === "done" ? 0 : 1;
}

/**
 * `tsforge scaffold …` — greenfield wizard that stands up boringstack (or its
 * Astro static site). Delegates the remaining argv to the scaffold command's own
 * parser (--archetype/--stack/--dest/--set/--multi/--ref/--no-boot), so its
 * vocabulary doesn't collide with the harness flags. Prints the handoff (where +
 * how to run the gate); the model-driven build loop is then a normal `tsforge`
 * invocation against that dir + gate.
 */
async function scaffoldMode(argv: readonly string[]): Promise<number> {
  const { runScaffoldCommand } = await import("./scaffold/scaffold-command");
  const outcome = await runScaffoldCommand(argv, process.stdout.isTTY);

  if (outcome === null) {
    process.stdout.write("scaffold: cancelled — nothing was created.\n");

    return 1;
  }

  process.stdout.write(
    [
      "",
      `scaffold ready → ${outcome.dir}`,
      `  cloned   ${outcome.resolvedSha}`,
      `  booted   ${String(outcome.booted)}${outcome.bootError === undefined ? "" : ` (${outcome.bootError})`}`,
      "",
      "configured .env:",
      ...outcome.summary.map((l) => `  ${l}`),
      "",
      "build it:",
      `  tsforge --dir ${outcome.gateCwd} --accept '${outcome.gateCommand}' "<your first feature>"`,
      "",
    ].join("\n")
  );

  return outcome.bootError === undefined ? 0 : 1;
}

export async function main(): Promise<number> {
  const raw = process.argv.slice(2);

  if (raw[0] === "scaffold") {
    return scaffoldMode(raw.slice(1));
  }

  const args = parseArgs(raw);

  if (args.recipes) {
    return recipesMode(args);
  }

  if (args.run && args.recipe.length === 0) {
    process.stdout.write(
      "missing recipe id — usage: tsforge run <id> [task] (see `tsforge recipes`)\n"
    );

    return 1;
  }

  // A `--recipe`/`run <id>` overlays the recipe's fields onto args (CLI wins),
  // then dispatch continues as if those were passed directly.
  const recipeAbort = await applyRecipeArg(args);

  if (recipeAbort !== null) {
    return recipeAbort;
  }

  if (args.review) {
    return reviewMode(args);
  }

  if (args.map) {
    return mapMode(args);
  }

  if (args.trace) {
    return traceMode(args);
  }

  if (args.setup) {
    return setupMode(args);
  }

  if (args.greenfield) {
    return greenfieldMode(args);
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
