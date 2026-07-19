import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  ITokenUsage,
} from "../inference";
import type { ITask } from "../spec";
import type { FileLinter } from "../gate";
import { makeFileLinter } from "../gate";
import { commandGate, type IGate } from "../gate/gate-runner";
import {
  type ADD_DEPENDENCY_TOOL,
  TOOL_NAME,
  buildSpawnAgentTool,
  READ_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
} from "../agent";
import type { IAgentSpec } from "../agent/agent-spec";
import type { SpawnAgentFn, IToolContext, EditGuard } from "./tools";
import type { PolicyMode } from "../policy";
import type { ProfileId } from "../config/profiles";
import {
  buildMetaRuleContext,
  runMetaRules,
  buildMetaBaseline,
  META_RULES,
  type MetaBaseline,
} from "../meta-rules";
import { flags } from "../config";
import { trace } from "../lib/trace";
import {
  validate,
  isEslintJsonLine,
  type ErrorParser,
  type ErrorSet,
} from "../validate";
import { ruleHelp } from "./feedback";
import { buildConventionIndex } from "./conventions";
import { detectStack } from "../stack-detection";
import { recallMapBlock } from "../codebase";
import {
  loadTsforgeConfig,
  withProfileOverride,
  normalizeRuleOverrides,
  resolveActivePacks,
} from "../config/tsforge-config";
import { connectMcpServers } from "../mcp";
import { loadAndRegisterPlugins } from "../config/external-plugins";
import {
  DEFAULT_TEMPERATURE,
  LOOP_LIMITS,
  RUN_STATUS,
  READONLY_STREAK_LIMIT,
  MAX_READONLY_RECOVERIES,
} from "./loop.constants";
import type { Reporter, ILoopEvent, IHandoff } from "./loop.types";
import type { TtsrManager } from "./ttsr";
import { initTtsrManager, applyTtsrInterrupt } from "./ttsr-init";
import { assistantMessage } from "./assistant-message";
import { selectThinking, offeredToolsFor } from "./model-call";
import {
  mineLessons,
  consolidate as consolidateMemory,
  type ICandidateLesson,
} from "./memory";
import {
  buildChatSystem,
  buildDriveToGreenSystem,
  buildTddGuidance,
  COMPACT_SYSTEM,
  type ExecutionMode,
} from "./prompt";
import { resolveConventions } from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import type { TsService } from "../lsp";
import {
  buildTsService,
  BUILD_NUDGE,
  buildHandoffAsk,
  emitTiming,
  type ILoopCtx,
  type ILoopState,
  isPhantomRouteError,
  NO_TOOL_CALL_NUDGE,
  runCheckGate,
  runToolCalls,
  settleGate,
  toolsFor,
  tryExpertRescue,
} from "./turn";

/** Signature of the memory-consolidation step, injectable for tests so they can
 *  capture the per-build source id each send passes. */
export type ConsolidateLessonsFn = (
  cwd: string,
  candidates: readonly ICandidateLesson[],
  source: string
) => Promise<number>;

/**
 * A persistent, tool-using conversation against a working directory — the engine
 * behind the interactive CLI. Unlike `runTask` (one RED-first task driven to
 * green and returned), a Session lives across many user messages: each `send()`
 * runs the model until it stops calling tools, then — IF a gate is configured —
 * the deterministic gate confirms "done" (green = accept, red = errors fed back,
 * keep going). With no gate it's a plain conversational turn. Same `turn.ts`
 * primitives as `runTask`, so there is one tool-loop and one gate, not two.
 */
export interface ISessionConfig {
  provider: IProvider;
  /** Working directory the agent operates in. */
  cwd: string;
  /** Editable scope — edits/creates outside these are rejected. Empty = read-only. */
  files?: string[];
  /** Gate command. When set, a turn that ends without tool calls is gate-confirmed. */
  accept?: string;
  /** Auto-fix command run before re-validating (e.g. `eslint --fix`). */
  fix?: string;
  /** Read-only context files. */
  context?: string[];
  parse?: ErrorParser;
  report?: Reporter;
  /** Test seam: override the memory-consolidation step (defaults to the real
   *  cross-build learned-rule pipeline). Lets a test observe the stable per-build
   *  source id passed on every send. */
  consolidateLessons?: ConsolidateLessonsFn;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokenBudget?: number;
  /** Runaway crash-guard on turns per send (default LOOP_LIMITS.runawayBackstopTurns).
   *  The PRIMARY terminal is ladder-exhaustion (R5 handoff), not this turn cap. */
  maxTurns?: number;
  /** Heartbeat cadence: emit checkpoint progress event every N turns without
   *  terminating (default LOOP_LIMITS.checkpointIntervalTurns). */
  checkpointIntervalTurns?: number;
  /** Base policy mode (from `--policy-mode`/config). Plan mode overrides it with
   *  `"plan"`; absent ⇒ `"default"`. */
  policyMode?: PolicyMode;
  /** Resume from a saved conversation (incl. its system message) instead of
   *  starting fresh — used by `--continue`. */
  history?: IChatMessage[];
  /** Extra opinionated guidance appended to the system prompt (e.g. a scaffold's
   *  conventions: "this is a web app, the entry is app.ts…"). */
  guidance?: string;
  /** The model's context window (tokens). When set, the session auto-compacts
   *  before a send once the held context exceeds `autoCompactAt` of it. 0/unset
   *  disables auto-compaction. */
  contextWindow?: number;
  /** Fraction of `contextWindow` that triggers auto-compaction (default 0.8). */
  autoCompactAt?: number;
  /** A FAST check (e.g. `tsc --noEmit`) run every `checkEvery` edits WHILE the
   *  model is still building — so errors surface a few edits after they're made,
   *  not as a 100-error avalanche when it finally stops. Empty = off. */
  incrementalCheck?: string;
  /** Edits between incremental checks (default 3). */
  checkEvery?: number;
  /** Write-time single-file linter (the gate's eslint rules per write). When set,
   *  the write-guard reports lint violations — the moat rules tsc can't see (`as`,
   *  `I`-prefix) — inline, so they're fixed in-context not piled up at the gate. */
  lintFile?: FileLinter;
  /** Optional edit guard that can veto+revert an applied edit. Set by a build
   *  BACKEND (e.g. boringstack) to inject a domain rule; the core edit tool stays
   *  domain-agnostic. Absent ⇒ no guard. */
  editGuard?: EditGuard;
  /** Rule profile override for this session (from a recipe); defaults to config file. */
  profile?: ProfileId;
  /** Offer the read-only `pull_conventions` tool — set by a build BACKEND that ships
   *  a convention library (e.g. boringstack) so the model can fetch its how-to
   *  patterns on demand. Decoupled from any flag: a plain session leaves it off. */
  pullConventions?: boolean;
  /** Offer the callable, structured `check` tool (WS-G) — set by a build BACKEND
   *  whose gate is authoritative (e.g. boringstack, which injects its gate per-slice
   *  via `setGate`). The tool runs the SAME full evaluation `settleGate` does
   *  (`runCheckGate` → autofix + gate command + META_RULES combined — NOT the gate
   *  runner alone) and returns the whole structured error set MID-TURN, so the model
   *  fixes every error in one pass. Left off for plain eval/scratch tasks (their
   *  acceptance set can be empty ⇒ vacuous). */
  offerCheck?: boolean;
  /** A real human is present to answer (the interactive REPL sets this). Threads to
   *  `ctx.tool.humanPresent` (NOT `ctx.tool.interactive` — that's a POLICY approval-path
   *  signal, and co-pilot presence must not loosen policy verdicts) and offers the
   *  `ask_user` tool (WS-C): the model can pause for a human decision. Absent/false ⇒
   *  unattended (headless/eval) — ask_user isn't offered and, if forced, returns
   *  "proceed" so a run never hangs. */
  interactive?: boolean;
  /** Composed gate the session's loop checks each cycle. Defaults to a command
   *  gate from `accept`. Use `setGate` to swap it per unit mid-build. */
  gate?: IGate;
  /** Pristine-scaffold meta-rule baseline to subtract from each cycle's violations.
   *  Usually captured mid-build via `captureMetaBaseline()`; this is for callers that
   *  already hold one at construction time. */
  metaBaseline?: MetaBaseline;
  /** How the model is driven. `"chat"` (default) = open-ended assistant framing;
   *  `"drive-to-green"` = the strict expert-TS implement contract (for autonomous
   *  builds), so the constitution is in force from the first token, not the gate. */
  executionMode?: ExecutionMode;
}

/** The outcome of one `send`. `responded` = conversational (no gate); the gate
 *  verdicts are `done`/`stuck` as in `runTask`; `interrupted` = the user aborted. */
export interface ISendResult {
  status: "responded" | "done" | "stuck" | "interrupted";
  turns: number;
  /** When stuck with a handoff: the structured, resumable handoff details. */
  handoff?: IHandoff;
  /** WS-C: set to the question when the send ended because the model called `ask_user`.
   *  The REPL delivers the user's NEXT line as the answer VERBATIM — bypassing plan
   *  approval / slash-command interception, so "go"/"approve" answers a question, not
   *  the plan (which would wrongly unlock mutating tools). */
  awaitingUser?: string;
}

/** Cumulative model-call metrics for a session — the basis for `/metrics`. */
export interface ISessionMetrics {
  /** Number of model calls made. */
  readonly calls: number;
  /** Total prompt (input) tokens billed across all calls. */
  readonly promptTokens: number;
  /** Total completion (output) tokens generated across all calls. */
  readonly completionTokens: number;
  /** Output generation rate averaged over all calls (tokens/second). */
  readonly avgTokensPerSecond: number;
  /** Output generation rate of the most recent call (tokens/second). */
  readonly lastTokensPerSecond: number;
}

export interface ISendOptions {
  /** Caller cancellation (Ctrl-C). */
  signal?: AbortSignal;
  /** Drained at each turn boundary — any returned strings are injected as user
   *  messages before the next model call, so the user can STEER a run in flight
   *  ("actually use Tailwind") without aborting it. */
  steer?: () => string[];
  /** Per-send thinking override (beats cfg.enableThinking for this send only).
   *  Used to keep thinking ON for the design phase (where reasoning earns its
   *  keep) but OFF for the mechanical implement phase, where ~25k tokens of
   *  pre-write reasoning per build is pure latency. */
  enableThinking?: boolean;
}

const SESSION_ID = "session";

/** ONE stable memory-source id for this whole PROCESS (= one build; the nightly
 *  loop spawns a fresh headless-build process per domain, and all of a build's
 *  features / revisit attempts / Sessions run inside it). Memory's recurrence
 *  gate (MIN_HITS_TO_ACTIVATE) treats a distinct `source` as a distinct session,
 *  so this MUST be stable across the build — a per-send/per-Session id makes a
 *  lesson mined twice within ONE build look like a cross-session recurrence,
 *  activate mid-build, and trap the model with notes about its own in-progress
 *  code (the learned-rule self-poisoning bug). Cross-build learning still works:
 *  a separate invocation is a new process with a new id, so a genuinely
 *  recurring lesson still bumps hits and activates on the next build. The pid
 *  disambiguates two builds started in the same millisecond (Date.now alone can
 *  collide), so genuine cross-build recurrence is never misread as same-build. */
export const MEMORY_RUN_ID = `${SESSION_ID}-${Date.now().toString(36)}-${process.pid.toString(36)}`;

/** A gate-output sink that also carries `flush()` — call it when the stream
 *  ends to emit any trailing line the process printed without a newline. */
export type IGateStreamSink = ((text: string) => void) & { flush: () => void };

/** Wrap a live gate-output sink so the machine-readable `eslint --format json`
 *  blob NEVER reaches the terminal — it's a single giant JSON line the harness
 *  parses internally and a human must not see (it was dumping raw at the end of
 *  every web run). Buffers across chunk boundaries: a line that begins `[{` is
 *  held until its newline, then dropped if it's the eslint JSON; everything else
 *  (vite build progress, tsc, test output) passes through unchanged. Call
 *  `flush()` at stream end so a final newline-less line isn't swallowed. */
export function filterGateStream(
  sink: (text: string) => void
): IGateStreamSink {
  let buf = "";

  const emit = (line: string): void => {
    if (!isEslintJsonLine(line)) {
      sink(line);
    }
  };

  const fn = (text: string): void => {
    buf += text;

    let nl = buf.indexOf("\n");

    // Emit only COMPLETE (newline-terminated) lines; HOLD any trailing partial
    // until its newline (or flush()). This is what makes the JSON drop reliable:
    // the eslint blob is one complete line, always evaluated whole and dropped —
    // the old partial flush leaked the JSON across chunk boundaries. Gate output
    // (vite/tsc/test) is line-based, so live progress isn't lost.
    while (nl !== -1) {
      emit(buf.slice(0, nl + 1));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  };

  // When the gate process exits, its last chunk may not end in a newline — emit
  // that remainder (still JSON-filtered) so no output is permanently lost.
  fn.flush = (): void => {
    if (buf.length > 0) {
      emit(buf);
      buf = "";
    }
  };

  return fn;
}

// assistantMessage moved to ./assistant-message so runTask (run.ts) and Session share
// ONE TTSR-aware builder — a fix in one path but not the other left the API-400 bug live.

/** Default share of the context window that triggers auto-compaction. */
const AUTO_COMPACT_AT = 0.8;

/** GENERAL plan mode (the default for a fresh interactive session; also the
 *  `/plan` toggle — distinct from the staged web build's PLAN_SUMMARY_STEP):
 *  rides the first user message after the mode flips on. Read-only tools enforce
 *  the contract at the execute layer; this note tells the model the workflow —
 *  explore, ask the few clarifying questions that matter, propose a plan, wait. */
const PLAN_MODE_NOTE =
  "[PLAN MODE — read-only. edit/create and write commands are disabled until " +
  "you propose a plan and the user approves it.]\n" +
  "Work in this order:\n" +
  "1. EXPLORE: read/search the code this request actually touches. Skip this for " +
  "a self-contained ask that has nothing to do with this repo — just answer it.\n" +
  "2. CLARIFY — ask only the FEW questions that most change the plan (scope, which " +
  "file/module to touch, the desired behavior, hard constraints). At most 3-4, as a " +
  "short numbered list, then STOP and wait for the answers. Do NOT ask what the code " +
  "or a sensible default already settles — state those as one-line assumptions " +
  "instead. Never interrogate: skip any question the user can't meaningfully answer.\n" +
  "3. GREENFIELD (building something new from scratch): say plainly, up front, that " +
  "the more detail and research the user provides now, the better the result — a " +
  "sharp spec (goals, who it is for, must-have features, tech/stack constraints, " +
  "reference examples, and explicit non-goals) yields a far better build than a vague " +
  "one. Then ask for the specific missing pieces that matter most. If the user would " +
  "rather not answer, proceed on clearly-stated assumptions — never block.\n" +
  "4. PLAN — once you know enough, reply with a concise plan under a `## Plan` " +
  "heading: each file to change and what to do in it, in order. For a small, " +
  "unambiguous change the plan can be a single line. No code dumps, no tool calls " +
  "in that reply.\n" +
  "The user replies with feedback (revise the plan) or approves it; you implement " +
  "ONLY after approval.";

/** Sent when the user approves a plan-mode plan — the plan itself is already the
 *  latest assistant message, so anchor it instead of re-pasting it. */
export const PLAN_APPROVED_NOTE =
  "Your plan is APPROVED — plan mode is off and all tools are available again. " +
  "Implement the approved plan above now, in order, starting with the first " +
  "step. Do not re-explore or restate the plan; emit the tool calls.";

/** Default edits between incremental checks. */
const CHECK_EVERY = 3;

/** Force the FULL gate after this many edits without the model yielding. The
 *  incremental check (CHECK_EVERY) is TS-only and the full gate normally runs only
 *  on yield — so a model stuck editing one file (never yielding) would never run
 *  the build, never see build/CSS errors, and never tick the no-progress guards
 *  (observed: 190 turns / 2 gate runs on a corrupted index.css). This bounds blind
 *  edit-churn: every Nth edit re-gates, surfacing the real error AND advancing the
 *  guards so a genuine loop is stopped. */
const FULL_GATE_EVERY = 9;

/** Edits between forced gates when NEAR-GREEN or already stalling — small, so the
 *  gate (and the escalation ladder it drives via `checkStuck`) cycles densely and
 *  climbs to the expert in a handful of turns. */
const FULL_GATE_EVERY_NEAR_GREEN = 2;

/** A gate error count at/under this is "near green" — close enough that dense,
 *  immediate feedback beats churning many blind edits between sparse gates. */
const NEAR_GREEN_ERRORS = 3;

/**
 * How many edits to allow before forcing a full gate. Normally `FULL_GATE_EVERY`,
 * but once the build is NEAR-GREEN (a small, non-zero last gate error count) or the
 * steer ladder has already begun, collapse toward `FULL_GATE_EVERY_NEAR_GREEN` so
 * the gate — and the escalation ladder that only advances per gate cycle — fires
 * densely and reaches the expert in a handful of turns instead of hundreds (a live
 * run ground ~100 turns at 1 error because gates were ~15–20 turns apart). Progress
 * isn't penalised: a new all-time-low error count resets the guards, so only a
 * genuine plateau escalates — this changes cadence, NOT any gate rule or threshold.
 */
export function forcedGateInterval(state: ILoopState): number {
  const lastCount = state.lastGateCount;
  const nearGreen = lastCount > 0 && lastCount <= NEAR_GREEN_ERRORS;
  const stalling = state.steerLevel > 0;

  return nearGreen || stalling ? FULL_GATE_EVERY_NEAR_GREEN : FULL_GATE_EVERY;
}

/** Reset convergence state at a `send()` boundary. A Session keeps conversation
 * and cumulative edit metrics across messages, but a new drive must not inherit an
 * exhausted ladder or sticky block from the previous drive. */
export function resetDriveConvergence(state: ILoopState): void {
  state.prevGateErrors = [];
  state.gateNoProgress = 0;
  state.bestErrorCount = Number.POSITIVE_INFINITY;
  state.noNewLow = 0;
  state.errorAge = new Map();
  state.lastGateCount = -1;
  state.steerLevel = 0;
  state.redGates = 0;
  state.blockFingerprint = "";
  state.recentGateFingerprints = [];
  state.triedLeversByBlock = new Map();
  state.pendingRung = null;
  state.pendingBlockFingerprint = null;
  state.pendingDiagnosisSteer = null;
  state.focusError = null;
  delete state.plateauBest;
  delete state.pendingSteer;
  delete state.resetContext;
  delete state.pendingModelOverride;
}

/** How many times a send recovers from a repetition loop before giving up. */
const MAX_DEGENERATION_RECOVERIES = 2;

/** How many times a send recovers from a model-request TIMEOUT before giving up.
 *  A single over-long turn (the model spiralled past the request timeout) must not
 *  throw away many turns of real progress — re-steer toward a small, fast turn and
 *  continue. Bounded so a server that's genuinely wedged still ends the run. */
const MAX_TIMEOUT_RECOVERIES = 2;

/** Pushed after a request timeout — the previous turn ran past the (generous)
 *  request timeout, almost always from too-long reasoning or one huge file. Demand
 *  a small, fast turn (paired with a forced, thinking-off tool call). */
const TIMEOUT_RESTEER =
  "Your previous response timed out — it ran too long (likely over-long reasoning " +
  "or one huge file). Make the SINGLE next tool call now: create or edit just ONE " +
  "file, kept small. Keep reasoning brief. No prose.";

/** True when an error is a request TIMEOUT (AbortSignal.timeout fires a
 *  `TimeoutError`), as opposed to a caller abort or a connection drop. */
function isModelTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return err.name === "TimeoutError" || /timed out|timeout/i.test(err.message);
}

/** Pushed after a repetition loop — break the spiral by demanding ONE concrete
 *  action (paired with a forced tool call, which can't loop in prose). */
const REPETITION_RESTEER =
  "You started repeating yourself. STOP — do not re-explain or re-decide. Emit " +
  "the SINGLE next tool call that makes concrete progress (create or edit ONE " +
  "file). No prose.";

/** Pushed on a read-only spin in a BUILD (gated) session — demand a concrete edit. */
const READONLY_RESTEER_BUILD =
  "You have made many tool calls in a row WITHOUT writing any file — only reading " +
  "or searching. STOP exploring. Emit the SINGLE next change now: create or edit " +
  "ONE file to make concrete progress. No more reads. No prose.";

/** Pushed on a read-only spin in a CONVERSATIONAL (no-gate) session — demand an
 *  answer (there is nothing to edit, so the failure is never wrapping up). */
const READONLY_RESTEER_ANSWER =
  "You have made many tool calls in a row without answering — only reading or " +
  "searching. You have enough context now. STOP reading and give your answer, " +
  "with no further tool calls.";

/** Prefaces interim-check feedback so the model fixes real errors and ignores the
 *  expected "module not found" noise from files it hasn't created yet. */
const INTERIM_CHECK_NOTE =
  "Interim type-check (NOT the final gate) — fix these now, while they are few, " +
  "before writing more. IGNORE any `Cannot find module './…'` for files you have " +
  "not created yet; fix the real type errors:";

/** How many interim errors to surface per turn (raw message + rule-doc lookup). */
const INTERIM_ERROR_CAP = 20;

/**
 * Compose the interim-check user message: the note, the capped raw error list,
 * and — when a failing rule has a curated doc — the fix RECIPE from `ruleHelp`.
 * Without this the build model saw only raw rule messages (e.g.
 * `i18n-locale-keys-used: … dead translation surface (remove … or wire it up)`)
 * and took the destructive path (deleting keys it just wrote) because nothing
 * taught it the constructive fix (wire the key into the UI state it names).
 * Exported for unit testing.
 */
export function interimCheckContent(errors: ErrorSet): string {
  const shown = errors.slice(0, INTERIM_ERROR_CAP);
  const detail = shown.map((e) => e.message).join("\n");
  // No silent truncation: if the cap dropped errors, say how many remain so the
  // model knows the list is partial (not that only `shown` are outstanding).
  const omitted = errors.length - shown.length;
  const more =
    omitted > 0
      ? `\n… and ${String(omitted)} more error(s) not shown — fix these first, then re-run.`
      : "";
  const help = ruleHelp(shown);
  const guidance = help.length > 0 ? `\n\n${help}` : "";

  return `${INTERIM_CHECK_NOTE}\n${detail}${more}${guidance}`;
}

/**
 * Did the model write whole files INTO its chat message instead of calling
 * `create`? Trips on ≥2 fenced code blocks (4 ``` markers), or one big block in
 * a long message — i.e. it dumped the app as prose. A single short illustrative
 * snippet in a chat answer does NOT trip it, so genuine Q&A is unaffected.
 */
function looksLikeCodeDump(content: string): boolean {
  const fences = (content.match(/```/g) ?? []).length;

  return fences >= 4 || (fences >= 2 && content.length > 1500);
}

const TOOL_NAMES_ALT = Object.values(TOOL_NAME).join("|");

/** Tool-call MARKUP leaked into the reply text: the known malformed variants
 *  (`<function=`, `<tool_call`, `<parameter…`, `<|tool|>`, `<tool>` for a tool
 *  we offer) — the server's parser left the call in content and salvage could
 *  not rescue it (see malformed-toolcall-format + wire.ts salvage). */
const LEAKED_CALL_RE = new RegExp(
  `<function=|<tool_call|<parameters?[=>]|<\\|(?:${TOOL_NAMES_ALT})\\|>|^<(?:${TOOL_NAMES_ALT})>`,
  "im"
);

/** The fully-degenerate invented-markup form: a short matched `<tag>…</tag>`
 *  pair on its own lines (e.g. `<files>\n["…"]\n</files>`, captured live). A
 *  legit prose answer with an HTML example could match — the cost is one
 *  bounded nudge turn, while missing it strands the whole build. */
const TAG_PAIR_RE = /^<([a-z_]+)>\s*$[\s\S]{0,400}?^<\/\1>\s*$/m;

/** Did the model emit a tool call as TEXT instead of invoking one? */
function leaksToolMarkup(content: string): boolean {
  return LEAKED_CALL_RE.test(content) || TAG_PAIR_RE.test(content);
}

/** Pushed when a no-tool-call reply contained leaked tool markup — the model
 *  believes it acted, but nothing ran. Paired with a FORCED tool call next turn
 *  (constrained decoding ⇒ the retry always parses). */
const MALFORMED_CALL_NUDGE =
  "Your last reply contained tool-call markup as plain TEXT — the syntax was " +
  "malformed, so NO tool ran and nothing happened. Do not write tool syntax " +
  "in prose. Re-issue that action as a real tool call now.";

/** CHAT_SYSTEM + the (optional) workspace map + a short orientation to the
 *  workspace and gate. The map block, when present, is injected right after
 *  CHAT_SYSTEM so the agent is oriented before the task-specific lines. */
/** Header of the DYNAMIC task-contract block. It carries the mutable facts (editable
 *  scope + active check) and is rebuilt from LIVE `ctx.task` by `refreshTaskContract`
 *  whenever `setScope`/`setGate` change them — so the top-priority prompt can never go
 *  stale (the old bug: "edit any file" persisting after scope narrowed to one feature).
 *  Kept as the LAST block of the system message; `guide()` inserts before it. */
const TASK_CONTRACT_MARKER = "## Current task contract";

/** The dynamic contract: what's editable right now + how acceptance is checked. */
function taskContract(files: string[], accept: string | undefined): string {
  const wholeRepo = files.length === 0 || files.includes("**/*");
  const scope = wholeRepo
    ? "Scope: you may read, run, and edit any file in the workspace."
    : `Scope: edit ONLY these paths — ${files.join(", ")}. Every other file is READ-ONLY; never edit it.`;
  const check =
    accept !== undefined && accept.length > 0
      ? `Check: \`${accept}\` runs automatically when you stop calling tools — fix any failures and continue until it passes.`
      : "";

  return [TASK_CONTRACT_MARKER, scope, check]
    .filter((s) => s.length > 0)
    .join("\n");
}

/** The STATIC system policy (identity, tools, conventions, workspace map, guidance) +
 *  the initial dynamic task contract. Base framing is mode-driven: `drive-to-green`
 *  (autonomous builds) gets the strict expert-TS implement contract; `chat` (default)
 *  gets the open-ended assistant framing. The scope/check facts live in the task
 *  contract (rebuilt per change), NOT baked statically here. */
function systemPrompt(
  cfg: ISessionConfig,
  workspaceMap: string,
  conventions: IConventions
): string {
  const base =
    cfg.executionMode === "drive-to-green"
      ? buildDriveToGreenSystem(
          conventions,
          cfg.offerCheck === true,
          cfg.pullConventions === true
        )
      : buildChatSystem(conventions);

  const lines = [`Workspace: ${cfg.cwd}`];

  if (cfg.guidance !== undefined && cfg.guidance.length > 0) {
    lines.push(cfg.guidance);
  }

  const prefix = workspaceMap.length > 0 ? `${workspaceMap}\n\n` : "";

  // TDD-first (default ON) — the headless build prompt gets this via
  // buildSystemPrompt, but the interactive path never did, so the CLI agent was
  // never TOLD to write tests first and leaned entirely on the late gate. Inject
  // it here too so test-first is the out-of-the-box default everywhere.
  const tdd = flags.tdd() ? `${buildTddGuidance(conventions)}\n\n` : "";

  // WS-A1: front-load the stack convention topic index when the backend ships a
  // convention library (pullConventions). PUSHes awareness that the catalog exists so
  // the model pulls the compliant pattern BEFORE writing — the Bucket-1 fix that stops
  // it drafting convention-violating code it then burns turns repairing.
  const conv =
    cfg.pullConventions === true ? `${buildConventionIndex()}\n\n` : "";

  const contract = taskContract(cfg.files ?? [], cfg.accept);

  return `${base}\n\n${tdd}${conv}${prefix}${lines.join("\n")}\n\n${contract}`;
}

/** Build the initial message list. A FRESH session gets one freshly-built system
 *  prompt. A RESUMED session (`cfg.history`) has its LEADING base-prompt system message
 *  refreshed to the current prompt, keeping every later message in order. Refreshing is
 *  unconditional and idempotent: the prompt is deterministic from `cfg`, so an unchanged
 *  config rebuilds the identical string, while a config that toggled a flag either way
 *  (`offerCheck`/`pullConventions` on OR off) gets a prompt consistent with what
 *  `toolsFor` now advertises — so a resumed build can never carry a prompt that requires
 *  or advertises a tool the session no longer exposes (the flag↔prompt invariant, both
 *  directions). Only the LEADING system message is replaced; a LATER persisted system
 *  instruction (delegation, scope notes) is preserved. This assumes `history[0]` is the
 *  generated base prompt — true for every caller here, since `create` always seeds it
 *  with `systemPrompt(cfg)` and later system text is APPENDED, never prepended. */
function resumeMessages(
  cfg: ISessionConfig,
  freshSystem: string
): IChatMessage[] {
  const systemMsg: IChatMessage = { role: "system", content: freshSystem };

  if (cfg.history === undefined || cfg.history.length === 0) {
    return [systemMsg];
  }

  const [first, ...rest] = cfg.history;

  return first?.role === "system"
    ? [systemMsg, ...rest]
    : [systemMsg, ...cfg.history];
}

/** Stable prefix of the delegation block — the sentinel `setDelegation` checks to
 *  stay idempotent across resumed/rebuilt sessions (so the prompt can't grow). */
const DELEGATION_MARKER = "DELEGATION:";

/** The system-prompt block that tells the orchestrator delegation exists and
 *  names the specialists, so it picks the right one without the user ever naming
 *  an agent. Appended (not baked into buildChatSystem) because the roster is
 *  known only after specs load. Starts with {@link DELEGATION_MARKER}. */
function delegationGuidance(specs: readonly IAgentSpec[]): string {
  const roster = specs
    .map((s) =>
      s.description === undefined ? `- ${s.id}` : `- ${s.id}: ${s.description}`
    )
    .join("\n");

  return [
    `${DELEGATION_MARKER} you can hand focused, read-only investigation to specialist subagents with the \`spawn_agent\` tool — exploring an unfamiliar part of the codebase, researching an external API/library, or verifying a claim — instead of spending your own turns and context on it. Spawn several in one turn for independent lines of inquiry; they run in parallel, each with its own context, and only YOU edit files. The user thinks in tasks and features, never in subagents — it is YOUR call when delegation helps.`,
    `Specialists available:\n${roster}`,
  ].join("\n\n");
}

/** Build a synthetic handoff for terminal exits (build-nudge, degeneration,
 *  timeout, readonly-spin, etc.) — a minimal, resumable handoff describing what
 *  a stronger model or human intervention is needed for. */
function buildSyntheticHandoff(
  block: string,
  errors: string[],
  diagnosticNote: string
): IHandoff {
  const ask = buildHandoffAsk(diagnosticNote, errors.slice(0, 3));

  return {
    block,
    rungHistory: [],
    errors: errors.slice(0, 3),
    ask,
    resumable: true,
    resume: { triedLevers: [] },
  };
}

export class Session {
  private readonly provider: IProvider;
  private readonly cfg: ISessionConfig;
  private readonly report: Reporter;
  private tools: (
    | ReturnType<typeof toolsFor>[number]
    | typeof ADD_DEPENDENCY_TOOL
    | NonNullable<ReturnType<typeof buildSpawnAgentTool>>
  )[];
  private hasGate: boolean;
  private readonly ctx: ILoopCtx;
  private readonly state: ILoopState;
  /** Token usage from the most recent model call — `promptTokens` is the real
   *  size of the context the model last saw (drives the status gauge and, soon,
   *  auto-compaction). */
  private lastUsage?: ITokenUsage;
  /** Running totals behind the `metrics` getter. genMs is the summed generation
   *  time (first-token→end) so the average rate is tokens/total-gen-seconds. */
  private readonly metricsTotals = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    genMs: 0,
    lastTokensPerSecond: 0,
  };
  /** Fast check run every few edits while building (e.g. tsc); "" = off. */
  private incrementalCheck: string;
  /** Per-send thinking override, set from ISendOptions for the duration of a
   *  `send` (cleared after). Lets the design phase think and the implement phase
   *  not. Undefined = fall back to cfg.enableThinking (server default). */
  private activeThinking?: boolean;
  /** ADAPTIVE THINKING: true while the model has outstanding errors to fix (an
   *  interim check or the gate came back RED). Measured: ~80% of build time is
   *  REPAIR, and thinking-OFF repair oscillates and never converges (churns to the
   *  turn cap), while thinking-ON repair converges. So we think ONLY while
   *  repairing — fast thinking-off creation, convergent thinking-on repair. */
  private repairing = false;
  /** GENERAL plan mode: read-only exploration until the user approves a plan.
   *  Mirrors into ctx.tool.readOnly (the execute-layer guarantee) and filters the
   *  advertised tool list per call — `this.tools` itself is never mutated, so
   *  toggling off restores everything with zero bookkeeping. */
  private planMode = false;
  /** The policy mode to fall back to when plan mode is OFF — from CLI/config
   *  (wired in `create`), default `"default"`. Plan mode overrides it with
   *  `"plan"`; toggling plan off restores THIS, not a hard `"default"`. */
  private baseMode: PolicyMode = "default";
  /** Attach PLAN_MODE_NOTE to the NEXT send only (not every revision reply). */
  private planIntroPending = false;
  /** Mid-session turn-cap override (setMaxTurns) — a web scaffold raises it. */
  private maxTurnsOverride?: number;
  /** TTSR manager (built-in + project + memory-learned rules). Null when TTSR is
   *  disabled. Built in `create` (needs async rule loading). */
  private ttsrManager: TtsrManager | null = null;
  /** Events of the CURRENT send (reset each drive), buffered off ctx.report so the
   *  post-send memory hook can mine the run for failure→fix lessons. */
  private readonly sendEvents: ILoopEvent[] = [];

  private constructor(cfg: ISessionConfig, ctx: ILoopCtx) {
    this.provider = cfg.provider;
    this.cfg = cfg;
    this.report = cfg.report ?? ((): void => undefined);
    this.hasGate =
      cfg.gate !== undefined ||
      (cfg.accept !== undefined && cfg.accept.length > 0);
    this.incrementalCheck = cfg.incrementalCheck ?? "";
    // Start with the 4 BASE tools (read/run/edit/create). Measured: the bigger
    // 11-tool list pushes this model onto a malformed-tool-call boundary (it
    // emits unparseable formats the server leaves in content) — see
    // malformed-toolcall-format. The base tools are enough to work a repo; the
    // LSP nav set can become an opt-in once we confirm it parses cleanly here.
    // Interactive sessions also get `search` (ripgrep): it's read-only, needs
    // no tsconfig, and is the plan-mode explorer's main tool besides `read`.
    // Headless/eval sessions keep the measured base set (see
    // lsp-tools-regress-scratch: nav tools hurt from-scratch builds).
    // `check` (WS-G): offered only when the build BACKEND opts in (`cfg.offerCheck`).
    // The boringstack build injects its authoritative gate per-slice via `setGate`
    // (not at construction), so this is an explicit flag, not `cfg.gate !== undefined`
    // (which is still undefined here). A plain eval/scratch task leaves it off — its
    // acceptance set can be empty, so a callable gate would answer vacuously.
    // Requires drive-to-green: only that base prompt is check-aware, and toolsFor must
    // not advertise check in a chat session whose prompt would omit + contradict it.
    // (`resumeMessages` keeps the persisted prompt in lockstep with this on resume, so
    // the advertised tool set and the prompt can never disagree in either direction.)
    const offerCheck =
      cfg.offerCheck === true && cfg.executionMode === "drive-to-green";

    this.tools = toolsFor(
      false,
      {},
      cfg.pullConventions === true,
      offerCheck,
      cfg.interactive === true
    );

    this.ctx = ctx;

    // Wire the `check` tool's runCheck seam to `runCheckGate` — the SAME full
    // evaluation `settleGate` runs (autofix → gate command → META_RULES combined),
    // so `check` can never report green while the end-of-turn settle is red. Reads
    // `this.ctx` LAZILY so a mid-build `setGate` swap is honored, and never
    // `validate(accept)` (empty for an injected gate — the vacuous-recheck trap).
    // Absent ⇒ the tool isn't offered and reports it isn't available.
    if (offerCheck) {
      this.ctx.tool.runCheck = () => runCheckGate(this.ctx);
    }

    // create() already resolved the base mode (CLI > config > default) onto ctx.
    this.baseMode = ctx.tool.policyMode ?? "default";
    this.ctx.tool.policyMode = this.planMode ? "plan" : this.baseMode;
    // Buffer events off ctx.report (where edit/create/validated flow) so the
    // post-send memory hook can mine them; still forward to the original reporter.
    const rawCtxReport = ctx.report;

    this.ctx.report = (event) => {
      this.sendEvents.push(event);
      rawCtxReport(event);
    };

    this.state = {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: Number.POSITIVE_INFINITY,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: -1,
      edits: 0,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      // Same signal as the pull_conventions tool: push + pull activate together.
      conventionsEnabled: cfg.pullConventions === true,
    };
  }

  /** Build a session (async because it spins up the TS LanguageService). */
  static async create(cfg: ISessionConfig): Promise<Session> {
    const task: ITask = {
      id: SESSION_ID,
      accept: cfg.accept ?? "",
      files: cfg.files ?? [],
      context: cfg.context,
      fix: cfg.fix,
    };

    const report = cfg.report ?? ((): void => undefined);
    // Same stack + tsforge.config.json resolution as the eval path
    // (resolveStackForRun in run.ts) — interactive users get identical
    // pack selection and rule-severity overrides.
    const detected = await detectStack(cfg.cwd);
    const projectConfig = withProfileOverride(
      await loadTsforgeConfig(cfg.cwd),
      cfg.profile
    );
    // Base policy mode + rules: CLI (`--policy-mode` via cfg) wins over the
    // config file's `policy.mode`, else `"default"`. Plan mode overrides this
    // base at runtime (setPlanMode).
    const baseMode = cfg.policyMode ?? projectConfig.policy?.mode ?? "default";
    const policyRules = projectConfig.policy?.rules;
    const activePacks = resolveActivePacks(detected.packs, projectConfig);
    // Opt-in: load rule packs from external plugins and fold their ids into the
    // active packs so the gate runs them. loadAndRegisterPlugins never throws.
    const externalPackIds =
      projectConfig.plugins === undefined
        ? []
        : await loadAndRegisterPlugins(
            projectConfig.plugins,
            cfg.cwd,
            (message) => {
              report({ kind: "tool", task: SESSION_ID, message });
            }
          );
    const stackProfile = {
      ...detected,
      packs:
        externalPackIds.length > 0
          ? [...activePacks, ...externalPackIds]
          : activePacks,
    };
    const ruleOverrides = normalizeRuleOverrides(projectConfig);

    // Opt-in: connect any configured MCP servers so their tools are offered to
    // the agent. A bad server is reported and skipped (connectMcpServers never
    // throws), so MCP can never block an interactive session from starting.
    const mcpRegistry =
      projectConfig.mcpServers === undefined
        ? null
        : await connectMcpServers(projectConfig.mcpServers, (message) => {
            report({ kind: "tool", task: SESSION_ID, message });
          });

    // Persisted workspace map (from `/map`), if any — primes the agent with the
    // repo's structure. Cheap: loads + marks drift, never rebuilds here.
    const workspaceMap = await recallMapBlock(cfg.cwd);

    const conventions = resolveConventions(projectConfig.conventions);

    // Write-time eslint moat. The interactive CLI passes its own `lintFile`; an
    // autonomous `drive-to-green` build gets one built from the DETECTED stack here
    // (headless-build needn't know the stack) so `as`/`!`/`any` surface per-write —
    // in seconds — instead of only at the ~90s gate. STRICT_CONFIG carries the moat.
    const lintFile =
      cfg.lintFile ??
      (cfg.executionMode === "drive-to-green"
        ? makeFileLinter(
            "core",
            cfg.cwd,
            stackProfile.packs,
            Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
            conventions
          )
        : undefined);

    const ctx: ILoopCtx = {
      task,
      cwd: cfg.cwd,
      tsService: await buildTsService(cfg.cwd),
      report,
      tool: {
        touched: new Set<string>(),
        policyMode: baseMode,
        ...(policyRules === undefined ? {} : { policyRules }),
        ...(mcpRegistry === null ? {} : { mcpRegistry }),
        ...(cfg.editGuard === undefined ? {} : { editGuard: cfg.editGuard }),
        // A real human is present (the interactive REPL) → ask_user can pause for an
        // answer; absent/false ⇒ unattended, ask_user proceeds without hanging. Set
        // `humanPresent`, NOT `interactive` — the latter is a POLICY signal (approval
        // path) and co-pilot presence must not loosen policy verdicts.
        ...(cfg.interactive === true ? { humanPresent: true } : {}),
      },
      gate: {
        parse: cfg.parse,
        stackProfile,
        ...(lintFile === undefined ? {} : { lintFile }),
        ...(Object.keys(ruleOverrides).length > 0 ? { ruleOverrides } : {}),
        ...(cfg.metaBaseline === undefined
          ? {}
          : { metaBaseline: cfg.metaBaseline }),
        // Stream the gate's output live (the interactive CLI), so a slow gate
        // (vite build + chromium) shows progress instead of running silently — but
        // filtered so the raw eslint JSON blob never floods the terminal.
        onGateChunk: filterGateStream((text) => {
          report({ kind: "token", task: SESSION_ID, message: text });
        }),
        runner: cfg.gate ?? commandGate(task, cfg.parse),
      },
      messages: resumeMessages(
        cfg,
        systemPrompt(cfg, workspaceMap, conventions)
      ),
    };

    const session = new Session(cfg, ctx);

    // Build the TTSR manager (built-in + project + memory-learned rules) so the
    // interactive loop gets the SAME mid-stream guidance the headless loop does —
    // including the failure→fix lessons learned in this repo.
    session.ttsrManager = await initTtsrManager(cfg.cwd, report, SESSION_ID);

    return session;
  }

  /** The current gate command (empty when none). */
  get gate(): string {
    return this.ctx.task.accept;
  }

  /** The policy posture plan mode toggles OFF to — CLI `--policy-mode` ?? config
   *  `policy.mode` ?? "default". Lets the CLI decide whether a fresh session
   *  should default to plan mode without re-loading the project config. */
  get basePolicyMode(): PolicyMode {
    return this.baseMode;
  }

  /** The editable scope globs. */
  get scope(): string[] {
    return this.ctx.task.files;
  }

  /** The session's TS LanguageService (null when the workspace has no tsconfig),
   *  exposed so spawned subagents can reuse it instead of each building their own
   *  (expensive, and it would negate the concurrency win). */
  get tsService(): TsService | null {
    return this.ctx.tsService;
  }

  /** Real token usage of the most recent model call (undefined until the first
   *  call, or if the server reports none). */
  get usage(): ITokenUsage | undefined {
    return this.lastUsage;
  }

  /** Cumulative model-call metrics (tokens + generation rate) for this session. */
  get metrics(): ISessionMetrics {
    const t = this.metricsTotals;

    return {
      calls: t.calls,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      avgTokensPerSecond:
        t.genMs > 0 ? Math.round((t.completionTokens / t.genMs) * 1000) : 0,
      lastTokensPerSecond: Math.round(t.lastTokensPerSecond),
    };
  }

  /** Fold one call's usage + generation time into the running metrics totals. */
  private recordUsage(usage: ITokenUsage, genMs: number): void {
    this.lastUsage = usage;
    this.metricsTotals.calls += 1;
    this.metricsTotals.promptTokens += usage.promptTokens;
    this.metricsTotals.completionTokens += usage.completionTokens;
    this.metricsTotals.genMs += genMs;
    this.metricsTotals.lastTokensPerSecond =
      genMs > 0 ? (usage.completionTokens / genMs) * 1000 : 0;
  }

  /** The real size of the context the model is currently holding — the prompt
   *  tokens of the last call (what auto-compaction watches), 0 before any call. */
  get contextTokens(): number {
    return this.lastUsage?.promptTokens ?? 0;
  }

  /** If the held context is at/over the auto-compact threshold, the percent full
   *  (for the notice); otherwise undefined. Needs a known window AND real usage
   *  from a prior turn — both absent on the first send, so it never fires early. */
  private autoCompactPct(): number | undefined {
    const window = this.cfg.contextWindow ?? 0;

    if (window <= 0 || this.lastUsage === undefined) {
      return undefined;
    }

    const fraction = this.lastUsage.promptTokens / window;
    const threshold = this.cfg.autoCompactAt ?? AUTO_COMPACT_AT;

    return fraction >= threshold ? Math.round(fraction * 100) : undefined;
  }

  /** Set (or clear, with "") the gate command mid-session, or swap the composed
   *  gate mid-build (one per unit/feature). For a gate runner, flips hasGate on so
   *  the loop actually runs it and the escalation ladder sees its failures. */
  setGate(arg: string | IGate): void {
    if (typeof arg === "string") {
      this.ctx.task.accept = arg;
      this.hasGate = arg.length > 0;
    } else {
      this.ctx.gate.runner = arg;
      this.hasGate = true;
    }

    this.refreshTaskContract();
  }

  /** Set the per-feature expert rescue target — the editable file the expert repairs
   *  when a stall's errors are all out of the model's scope (e.g. the resource service
   *  file). Cleared with "". Threaded to the loop via `ctx.gate.expertRescueTarget`. */
  setExpertRescueTarget(file: string): void {
    this.ctx.gate.expertRescueTarget = file.length > 0 ? file : undefined;
  }

  /** Capture the meta-rule baseline of the CURRENT (pristine) workspace using this
   *  session's own resolved stack profile + rule overrides, and store it so every
   *  later cycle subtracts it (pre-existing scaffold debt never blocks a feature).
   *  Call ONCE before any model work. Empty `changed` ⇒ only global rules seed it;
   *  change-scoped rules (e.g. test-sibling) correctly don't enter the baseline.
   *  Degrades silently — a throwing rule leaves the baseline unset (no suppression). */
  captureMetaBaseline(): void {
    try {
      const metaContext = buildMetaRuleContext(
        this.ctx.cwd,
        this.ctx.gate.stackProfile?.packs ?? [],
        []
      );
      const violations = runMetaRules(
        META_RULES,
        metaContext,
        this.ctx.gate.ruleOverrides
      );

      this.ctx.gate.metaBaseline = buildMetaBaseline(violations);
    } catch {
      // Supplementary to the gate — never crash the build over baseline capture.
    }
  }

  /** Raise/lower the per-send turn cap mid-session — `scaffold_web` flips a chat
   *  session into a from-scratch web build, whose heavy gate needs the bigger
   *  webMaxTurns budget (0/undefined restores the config default). */
  setMaxTurns(n?: number): void {
    this.maxTurnsOverride = n !== undefined && n > 0 ? n : undefined;
  }

  /** Toggle GENERAL plan mode: read-only tools + the plan-then-approve workflow.
   *  ON ⇒ the next send carries PLAN_MODE_NOTE, the advertised tools shrink to
   *  the read-only set, and the execute layer rejects any mutating call. */
  setPlanMode(on: boolean): void {
    this.planMode = on;
    this.ctx.tool.readOnly = on; // the hard guarantee at the execute layer
    // Plan forces the read-only policy mode; toggling off restores the base mode
    // (e.g. an explicit --policy-mode ci), not a hard reset to "default".
    this.ctx.tool.policyMode = on ? "plan" : this.baseMode;
    this.planIntroPending = on;
  }

  /** Set (or clear, with "") the auto-fix command run before each gate — e.g. a
   *  scaffold's `eslint --fix`, so mechanical lint violations are squashed
   *  deterministically instead of costing the model turns. */
  setFix(command: string): void {
    this.ctx.task.fix = command.length > 0 ? command : undefined;
  }

  /** Set (or clear, with "") the fast incremental check (e.g. `tsc --noEmit`) run
   *  every few edits while building, so errors surface early instead of piling up. */
  setIncrementalCheck(command: string): void {
    this.incrementalCheck = command;
  }

  /** Wire the PER-WRITE lint moat — the gate's eslint rules applied to each file
   *  AS it's written, so `as`-casts, no-jsx-computation, hooks-in-component-body,
   *  component-folder-structure, etc. surface immediately instead of as an
   *  end-of-turn pile-up. The interactive session was missing this (only headless
   *  builds wired it), so a whole web app's worth of violations dumped at the gate.
   *  Used at create and when `scaffold_web` flips a session to the web stack. */
  setLintFile(lintFile: FileLinter | undefined): void {
    this.ctx.gate.lintFile = lintFile;
  }

  /** Rebuild the in-process TS LanguageService. `scaffold_web` creates the
   *  project's tsconfig + node_modules AFTER the (empty-dir) session was created,
   *  so the service built at create time is empty/null and the per-write guard —
   *  which holds BOTH the tsc diagnostics AND the eslint lint moat — was skipped
   *  for the whole web build (`tsService !== null` was false). Rebuilding here
   *  makes per-write feedback actually fire in web sessions, matching headless. */
  async refreshTsService(): Promise<void> {
    // Dispose the old service first — it holds program/document-registry refs
    // that would otherwise leak when we drop the reference.
    this.ctx.tsService?.dispose();
    this.ctx.tsService = await buildTsService(this.ctx.cwd);
  }

  /** Replace the editable scope globs mid-session. Also refreshes the system
   *  message's task contract so the prompt reflects the NEW scope on the very next
   *  model call (not the whole-repo scope it was created with). */
  setScope(globs: string[]): void {
    this.ctx.task.files = globs;
    this.refreshTaskContract();
  }

  /** Rebuild the dynamic task-contract block (scope + check) from the LIVE
   *  `ctx.task`, replacing the old block in place. The static policy above the
   *  marker is untouched. No system message yet (shouldn't happen) ⇒ no-op. */
  private refreshTaskContract(): void {
    const system = this.ctx.messages[0];

    if (system?.role !== "system") {
      return;
    }

    const fresh = taskContract(this.ctx.task.files, this.ctx.task.accept);
    const idx = system.content.indexOf(TASK_CONTRACT_MARKER);

    system.content =
      idx === -1
        ? `${system.content}\n\n${fresh}`
        : `${system.content.slice(0, idx).trimEnd()}\n\n${fresh}`;
  }

  /** Update the context window mid-session (e.g. after a `/model` hot-swap to a
   *  model with a different window). Without this, `autoCompactPct()` keeps using
   *  the original window, so switching to a SMALLER model would compact too late
   *  and overflow it — even though the status bar already shows the new size. */
  setContextWindow(window: number): void {
    this.cfg.contextWindow = window;
  }

  /** Enable model-driven delegation: offer the `spawn_agent` tool (its
   *  `subagent_type` enum built from the available specialists), wire the runner
   *  callback, and tell the model it can delegate. Late-bound (after create)
   *  because the callback is built by the CLI, which owns model resolution and
   *  the concurrency limiter. No specs ⇒ no-op (nothing to delegate to). */
  setDelegation(specs: readonly IAgentSpec[], fn: SpawnAgentFn): void {
    const tool = buildSpawnAgentTool(specs);

    if (tool === null) {
      return;
    }

    this.ctx.tool.spawnAgent = fn;

    // Idempotent: setDelegation runs on EVERY REPL launch, and a resumed
    // (`--continue`) session reuses persisted history whose system message
    // already carries the guidance. Re-adding the tool or re-appending the block
    // would duplicate them (the prompt would grow each launch). Guard on the
    // tool name and the guidance marker so a rebuilt/fresh session gets them once.
    if (!this.tools.some((t) => t.function.name === tool.function.name)) {
      this.tools = [...this.tools, tool];
    }

    const system = this.ctx.messages[0];

    if (!(
      system?.role === "system" && system.content.includes(DELEGATION_MARKER)
    )) {
      this.guide(delegationGuidance(specs));
    }
  }

  /** Offer the image tools when their capability backends are configured. Called
   *  on REPL launch after capabilities are resolved; idempotent (a resumed session
   *  re-runs it) — mirrors setDelegation's guard so the tool list can't grow on
   *  each launch. `read_image` needs vision, `generate_image` needs imageGen. */
  setImageCapabilities(caps: { vision: boolean; imageGen: boolean }): void {
    const add = [
      ...(caps.vision ? [READ_IMAGE_TOOL] : []),
      ...(caps.imageGen ? [GENERATE_IMAGE_TOOL] : []),
    ];

    for (const tool of add) {
      if (!this.tools.some((t) => t.function.name === tool.function.name)) {
        this.tools = [...this.tools, tool];
      }
    }
  }

  /** Wire the inline-image preview callback the `generate_image` tool fires after
   *  saving (the CLI emits the terminal's inline-image escape). Absent ⇒ the tool
   *  just reports the saved path. */
  setPreviewImage(fn: IToolContext["previewImage"]): void {
    this.ctx.tool.previewImage = fn;
  }

  /** Append opinionated guidance to the SYSTEM prompt (e.g. after classifying a
   *  fresh request as a web build). Folded into the existing system message — a
   *  second system message breaks some chat templates (Qwen → 400). */
  guide(text: string): void {
    const first = this.ctx.messages[0];

    if (first?.role === "system") {
      // Insert BEFORE the dynamic task contract so it stays the final block (and
      // `refreshTaskContract` can splice it without clobbering this guidance).
      const idx = first.content.indexOf(TASK_CONTRACT_MARKER);

      first.content =
        idx === -1
          ? `${first.content}\n\n${text}`
          : `${first.content.slice(0, idx).trimEnd()}\n\n${text}\n\n${first.content.slice(idx)}`;
    } else {
      this.ctx.messages.unshift({ role: "system", content: text });
    }
  }

  /**
   * Compress the conversation: ask the model to summarize everything so far, then
   * replace the history with [system, summary]. Frees context for long sessions
   * while preserving goals/decisions/changes. Returns the message count before/after.
   */
  async compact(
    signal?: AbortSignal
  ): Promise<{ before: number; after: number }> {
    const { ctx } = this;
    const before = ctx.messages.length;
    const conversation = ctx.messages.filter((m) => m.role !== "system");

    if (conversation.length === 0) {
      return { before, after: before };
    }

    const transcript = conversation
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
    const res = await this.provider.complete(
      [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user", content: transcript },
      ],
      { temperature: 0, ...(signal === undefined ? {} : { signal }) }
    );

    const system = ctx.messages[0];
    const summary: IChatMessage = {
      role: "user",
      content: `[Summary of the earlier conversation]\n${res.content}`,
    };

    ctx.messages = system?.role === "system" ? [system, summary] : [summary];

    return { before, after: ctx.messages.length };
  }

  /** The live conversation (system + every exchange). Read-only view. */
  get messages(): readonly IChatMessage[] {
    return this.ctx.messages;
  }

  /**
   * Run one user message: drive the model until it stops calling tools, then
   * gate-confirm if a gate is set. Loops on red gate feedback up to the turn cap.
   */
  async send(text: string, opts: ISendOptions = {}): Promise<ISendResult> {
    const { ctx, report } = this;
    // Runaway crash-guard (not the primary stop — the progress guards pull out when
    // converging stops). The PRIMARY terminal is ladder-exhaustion (R5 handoff).
    const maxTurns =
      this.maxTurnsOverride ??
      this.cfg.maxTurns ??
      LOOP_LIMITS.runawayBackstopTurns;

    const checkpointIntervalTurns =
      this.cfg.checkpointIntervalTurns ?? LOOP_LIMITS.checkpointIntervalTurns;
    const sendStart = performance.now();

    // Thread cancellation to the tool `run` commands and the gate (not just the
    // model call), so Ctrl-C kills in-flight child processes too.
    ctx.tool.signal = opts.signal;
    this.activeThinking = opts.enableThinking;
    this.repairing = false; // fresh send starts in (fast, thinking-off) creation mode
    resetDriveConvergence(this.state);

    // The TtsrManager persists for the whole session, so per-rule silencing and
    // the global interrupt cap must reset per user message — otherwise a rule
    // silenced (or the manager disabled) during one prompt stays off for every
    // later, unrelated prompt. The headless run.ts path builds a fresh manager
    // per run and needs neither reset.
    this.ttsrManager?.resetInterrupts();
    this.state.ttsrInterrupts = 0;

    try {
      // Auto-compact BEFORE adding the new message (so it stays a fresh turn
      // after the summary) when the held context is near the window.
      const pct = this.autoCompactPct();

      if (pct !== undefined) {
        report({
          kind: "tool",
          task: SESSION_ID,
          message: `⊙ context ~${pct}% full — auto-compacting to free room`,
        });

        const { before, after } = await this.compact(opts.signal);

        report({
          kind: "tool",
          task: SESSION_ID,
          message: `⊙ compacted ${before} → ${after} messages`,
        });
      }

      // The plan-mode workflow note rides the FIRST message after the mode flips
      // on; revision replies go bare (the instruction persists in history).
      if (this.planMode && this.planIntroPending) {
        this.planIntroPending = false;
        ctx.messages.push({
          role: "user",
          content: `${text}\n\n${PLAN_MODE_NOTE}`,
        });
      } else {
        ctx.messages.push({ role: "user", content: text });
      }

      return await this.drive(
        maxTurns,
        checkpointIntervalTurns,
        sendStart,
        opts
      );
    } catch (err) {
      if (opts.signal?.aborted === true) {
        report({
          kind: "stuck",
          task: SESSION_ID,
          message: "interrupted",
        });

        return { status: "interrupted", turns: 0 };
      }

      // A provider/network error (request timeout, connection drop after retries)
      // ends the turn GRACEFULLY as stuck — never crash the process. The message
      // is logged so it's visible/debuggable, not silently swallowed. This keeps a
      // long autonomous run (and the interactive CLI) alive through a flaky model.
      const detail = err instanceof Error ? err.message : String(err);

      report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request failed: ${detail}`,
      });

      return { status: "stuck", turns: 0 };
    } finally {
      ctx.tool.signal = undefined;
      this.activeThinking = undefined;
    }
  }

  /** Once `editsSinceCheck` reaches the threshold, run the incremental check and
   *  reset the counter; otherwise pass it through. Keeps `drive` branch-light. */
  private async checkAfterEdits(
    editsSinceCheck: number,
    checkEvery: number
  ): Promise<number> {
    if (editsSinceCheck < checkEvery) {
      return editsSinceCheck;
    }

    await this.runIncrementalCheck();

    return 0;
  }

  /** Run the fast incremental check (e.g. tsc) and, if it surfaces errors, feed
   *  them back NOW as a user message so the model fixes them before writing more
   *  — instead of letting them pile up for the final gate. No-op when unset. */
  private async runIncrementalCheck(): Promise<void> {
    if (this.incrementalCheck.length === 0) {
      return;
    }

    const { ctx } = this;
    const task: ITask = { ...ctx.task, accept: this.incrementalCheck };
    const result = await validate(
      task,
      ctx.cwd,
      ctx.gate.parse,
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
    );

    // Drop stub-route-tree phantoms (the build regenerates the tree at the gate) —
    // the model can't fix them and shouldn't be told to try.
    const errors = result.errors.filter((e) => !isPhantomRouteError(e.message));

    if (result.passed || errors.length === 0) {
      this.repairing = false; // clean (or only phantoms) → fast thinking-off creation

      return;
    }

    this.repairing = true; // errors outstanding → next turns think to converge

    const detail = errors
      .slice(0, INTERIM_ERROR_CAP)
      .map((e) => e.message)
      .join("\n");

    // Surface the ACTUAL errors into the log (not just the count) — so we can see
    // WHAT the model fails at and target the systematic ones in the harness.
    ctx.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ interim check: ${String(errors.length)} error(s) — fixing now:\n${detail}`,
    });

    // The pushed message adds the curated fix RECIPE (ruleHelp) on top of the raw
    // errors, so the model gets the constructive fix (e.g. WIRE UP an unused i18n
    // key) instead of only the raw rule message that invites deletion.
    ctx.messages.push({
      role: "user",
      content: interimCheckContent(errors),
    });
  }

  /** The turn loop — separated so `send` can wrap it in abort handling. */
  /** One model call: stream thinking live, push the reply, and surface salvage +
   *  the highlighted answer. Keeps `drive`'s per-turn control flow lean. */
  private async askModel(
    signal?: AbortSignal,
    toolChoice: "auto" | "required" = "auto",
    forceNoThinking = false
  ): Promise<IModelResponse> {
    const { ctx, report } = this;
    // On a FORCED tool turn, disable thinking: the model already decided what to
    // do, and thinking-on is a known source of prose-before-the-call malformed
    // output on this model. `required` + thinking-off = the cleanest tool call.
    // ADAPTIVE: think while REPAIRING (errors outstanding) so repair converges;
    // otherwise honour the per-send/cfg setting (off = fast creation). A forced
    // recovery turn always thinks-off (it just needs one clean tool call).
    const enableThinking = selectThinking({
      forceNoThinking,
      repairing: this.repairing,
      activeThinking: this.activeThinking,
      configured: this.cfg.enableThinking,
    });
    // PLAN MODE advertises only the read-only tools (+ `run`, whose handler
    // enforces a read-only command allowlist) — the model never sees a write
    // tool. Filtered per call, so `this.tools` is untouched and toggling the
    // mode off restores the full set with zero bookkeeping.
    const offeredTools = offeredToolsFor(
      this.tools,
      this.planMode,
      this.ctx.tool.mcpRegistry?.toolSchemas() ?? []
    );
    const callStart = performance.now();
    let firstTokenAt = 0;

    this.ttsrManager?.resetBuffer();

    // R2 per-call model overrides (temperature, reasoning effort) — applied to
    // the NEXT main-loop turn only, then cleared. Auxiliary calls (planning,
    // judge, expert) stay on config defaults. Applied by R2 (reason-more) rung.
    const override = this.state.pendingModelOverride;
    const temperature =
      override?.temperature ?? this.cfg.temperature ?? DEFAULT_TEMPERATURE;
    const reasoningEffort = override?.reasoningEffort;

    // Clear the pending override immediately after reading it into locals, BEFORE
    // the provider call. If complete() throws, this ensures the override won't leak
    // into the next successful call (exception-safe one-shot semantics).
    this.state.pendingModelOverride = null;

    const res = await this.provider.complete(ctx.messages, {
      tools: offeredTools,
      temperature,
      toolChoice,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(this.cfg.thinkingTokenBudget === undefined
        ? {}
        : { thinkingTokenBudget: this.cfg.thinkingTokenBudget }),
      ...this.ttsrCallOption(),
      ...(signal === undefined ? {} : { signal }),
      onToken: (token, channel) => {
        // Stamp the first token so tokens/sec measures generation rate (excluding
        // prompt-processing / time-to-first-token), not total wall time.
        if (firstTokenAt === 0) {
          firstTokenAt = performance.now();
        }

        // Stream EVERYTHING live — thinking, the tool calls being written, and
        // the answer itself (channel `content`), so the user watches the reply
        // arrive instead of staring at a frozen indicator. The renderer formats
        // content incrementally line-by-line; the consolidated `message` event
        // below stays as the log's record (the interactive renderer dedupes it).
        report({ kind: "token", task: SESSION_ID, message: token, channel });
      },
    });

    if (res.usage !== undefined) {
      const ended = performance.now();
      const genMs = firstTokenAt > 0 ? ended - firstTokenAt : ended - callStart;
      const tps = genMs > 0 ? (res.usage.completionTokens / genMs) * 1000 : 0;

      this.recordUsage(res.usage, genMs);
      // Logged (not shown) so the --log analyzer can compute tokens-to-solution.
      // `thinking` records THIS call's mode, so malformed-call rates can be
      // correlated with it (analyze-malformed).
      report({
        kind: "usage",
        task: SESSION_ID,
        message: `tokens ${res.usage.promptTokens} in / ${res.usage.completionTokens} out · ${Math.round(tps)} tok/s`,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
        tokensPerSecond: Math.round(tps),
        ms: Math.round(genMs),
        ...(enableThinking === undefined ? {} : { thinking: enableThinking }),
      });
    }

    ctx.messages.push(assistantMessage(res));

    // Every model call advances TTSR cooldown accounting (including interrupted
    // ones, so repeatGap rules count correctly after a retry).
    this.ttsrManager?.incrementTurnCount();

    if (res.salvaged !== undefined && res.salvaged > 0) {
      report({
        kind: "tool",
        task: SESSION_ID,
        message: `⚠ recovered ${res.salvaged} malformed tool call(s) (server tool-call parser mismatch)`,
        ...(enableThinking === undefined ? {} : { thinking: enableThinking }),
      });
    }

    if (res.content.length > 0) {
      report({ kind: "message", task: SESSION_ID, message: res.content });
    }

    return res;
  }

  /**
   * Decide what a turn that ended with NO tool calls (and no edits yet this send)
   * means. A plain answer — no gate, or a conversational reply — is `responded`.
   * But with a gate set and the reply DUMPING whole files as prose (instead of
   * calling `create`), that's the narrate-instead-of-build failure: the content
   * never reaches disk. We nudge it to act (`result: null`, capped); past the cap
   * we stop honestly rather than loop forever. Side effects (the nudge message,
   * the stuck report) happen here; the caller only emits timing and loops/returns.
   */
  private resolveNoEditYield(
    content: string,
    turn: number,
    buildNudges: number
  ): { result: ISendResult | null } {
    // Plan mode is read-only — a fenced-snippet-heavy PLAN is the desired
    // output, not a narrate-instead-of-build failure; never nudge it to build.
    if (this.planMode) {
      return { result: { status: "responded", turns: turn } };
    }

    // Leaked tool markup = the model TRIED to act but the call never parsed
    // (and salvage couldn't rescue it). Without this nudge the turn ends as a
    // fake "responded" and the build silently strands (captured live: a
    // scaffold_web emitted as text). The retry is a FORCED tool call, which is
    // grammar-constrained — so it always parses.
    const leaked = this.hasGate && leaksToolMarkup(content);
    // An EMPTY no-tool reply mid-gated-build is never a valid conclusion — it
    // is the signature of a degenerate/failed provider response (captured
    // live: a 675ms "reply" during an endpoint flap ended a 180-turn build as
    // "responded" with only the scaffold on disk). Nudge-with-cap, like the
    // other mid-build non-answers.
    const emptyMidBuild = this.hasGate && content.trim().length === 0;

    if (
      !leaked &&
      !emptyMidBuild &&
      (!this.hasGate || !looksLikeCodeDump(content))
    ) {
      return { result: { status: "responded", turns: turn } };
    }

    if (buildNudges >= LOOP_LIMITS.maxBuildNudges) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const diagnosticNote = leaked
        ? "malformed tool-call format"
        : emptyMidBuild
          ? "repeated empty replies"
          : "model narrating instead of creating files";
      const handoff = buildSyntheticHandoff(
        "build-nudge",
        errorMessages,
        diagnosticNote
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message: leaked
          ? "⚠ model kept emitting malformed tool-call text instead of real " +
            "calls — stopped. See malformed-toolcall-format (server parser)."
          : emptyMidBuild
            ? "⚠ model kept returning empty replies mid-build — stopped " +
              "(endpoint likely degraded; the run is incomplete, not done)."
            : "⚠ model kept writing files as chat messages instead of creating " +
              "them — stopped. Try a smaller step (e.g. one file at a time).",
      });

      return { result: { status: "stuck", turns: turn, handoff } };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: leaked
        ? "↳ malformed tool-call text (no tool ran) — forcing a real call"
        : emptyMidBuild
          ? "↳ empty reply during a gated build — asking the model to continue"
          : "↳ no files written — nudging the model to build with tools",
    });
    this.ctx.messages.push({
      role: "user",
      content: leaked ? MALFORMED_CALL_NUDGE : BUILD_NUDGE,
    });

    return { result: null };
  }

  /** Handle a repetition-loop detection: stop (return a stuck result) once the
   *  recovery budget is spent, else re-steer toward one concrete action and
   *  return null so the caller forces a tool call next turn. */
  private degenerationRecovery(
    degenerations: number,
    turn: number
  ): ISendResult | null {
    if (degenerations >= MAX_DEGENERATION_RECOVERIES) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const handoff = buildSyntheticHandoff(
        "degeneration-budget",
        errorMessages,
        "model fell into a repetition loop"
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ repetition loop persisted after recovery attempts — stopped. Try a smaller step.",
      });

      return { status: "stuck", turns: turn, handoff };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: "⚠ repetition loop — forcing a concrete next action",
    });
    this.ctx.messages.push({ role: "user", content: REPETITION_RESTEER });

    return null;
  }

  /** Handle a thrown model call: rethrow a caller abort or any non-timeout error
   *  (terminal — send()'s handler turns it into interrupted/stuck). A request
   *  TIMEOUT is recoverable: emit timing, then stop (return stuck) once the budget
   *  is spent, else re-steer toward a small fast turn and return null so the caller
   *  forces a (thinking-off) tool call and CONTINUES — preserving the turns already
   *  done rather than abandoning the whole build on one over-long turn. */
  private recoverFromTimeout(
    err: unknown,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    signal?: AbortSignal
  ): ISendResult | null {
    if (signal?.aborted === true || !isModelTimeout(err)) {
      throw err;
    }

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    // Log the RAW error so the timeout's true source (request-timeout ceiling vs a
    // server-side stream close) is diagnosable from the --log, not swallowed.
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);

    if (timeouts >= MAX_TIMEOUT_RECOVERIES) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const errorType = detail.split(":")[0] ?? "unknown";
      const handoff = buildSyntheticHandoff(
        `timeout:${errorType}`,
        errorMessages,
        `model request timed out: ${detail}`
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request timed out repeatedly (${detail}) — stopped. The server may be wedged or the task too large for one turn.`,
      });

      return { status: "stuck", turns: turn, handoff };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚠ model request timed out (${detail}) — re-steering to a smaller turn and continuing (${String(timeouts + 1)}/${String(MAX_TIMEOUT_RECOVERIES)})`,
    });
    this.ctx.messages.push({ role: "user", content: TIMEOUT_RESTEER });

    return null;
  }

  /** Inject any messages the user typed mid-run (steering) before the next turn. */
  private injectSteer(steer?: () => string[]): void {
    for (const message of steer?.() ?? []) {
      this.ctx.messages.push({ role: "user", content: message });
      this.report({
        kind: "tool",
        task: SESSION_ID,
        message: `↳ steering: ${message.slice(0, 60)}`,
      });
    }
  }

  /** One model turn for `drive`, with timeout recovery folded in so the loop body
   *  stays lean: `ok` → use the response; `stop` → terminal result; `retry` →
   *  timed out, re-steer applied, force a small tool call next turn. A caller abort
   *  or non-timeout error propagates (via recoverFromTimeout) to send()'s handler. */
  private async acquireResponse(
    forceTool: boolean,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<
    | { kind: "ok"; res: IModelResponse }
    | { kind: "stop"; result: ISendResult }
    | { kind: "retry" }
  > {
    try {
      // A recovery force disables thinking for a clean call.
      const res = await this.askModel(
        opts.signal,
        forceTool ? "required" : "auto",
        forceTool
      );

      return { kind: "ok", res };
    } catch (err) {
      const recovered = this.recoverFromTimeout(
        err,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts.signal
      );

      return recovered !== null
        ? { kind: "stop", result: recovered }
        : { kind: "retry" };
    }
  }

  /** Run the tool calls of a turn, account the edits, emit timing, and run the
   *  incremental check every few edits — returns the updated edit accounting so
   *  `drive`'s loop body stays lean. */
  private async runEditTurn(
    res: IModelResponse,
    acc: { edited: boolean; editsSinceCheck: number; checkEvery: number },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    edited: boolean;
    editsSinceCheck: number;
    progressed: boolean;
  }> {
    const { ctx, state, report } = this;
    const before = state.edits;
    // `progressed` = this turn touched an editable file (hand-write OR scaffold/
    // semantic mutation), the per-turn signal the read-only-spin guard counts on.
    // `edited` stays cumulative for the gate-confirm decision.
    const progressed = await runToolCalls(res.toolCalls, ctx, state);
    const edited = progressed || acc.edited;

    emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

    // Check every few edits WHILE building, so errors surface early instead of
    // piling up into a final avalanche the model can't dig out of.
    const editsSinceCheck = await this.checkAfterEdits(
      acc.editsSinceCheck + (state.edits - before),
      acc.checkEvery
    );

    return { edited, editsSinceCheck, progressed };
  }

  /** A working turn (the model emitted tool calls): run them via `runEditTurn`,
   *  then apply the read-only-spin guard. Returns the carried counters plus an
   *  `action` — a terminal `ISendResult` to stop on, or "continue" to keep
   *  looping. Keeps the guard's bookkeeping out of `drive`'s loop body. A turn
   *  that touched an editable file resets the streak; a pure read/search/run turn
   *  extends it, and past the limit `readonlySpinStop` re-steers (bounded) or stops. */
  private async runToolTurn(
    res: IModelResponse,
    carry: {
      edited: boolean;
      editsSinceCheck: number;
      checkEvery: number;
      readonlyStreak: number;
      readonlyRecoveries: number;
    },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    edited: boolean;
    editsSinceCheck: number;
    readonlyStreak: number;
    readonlyRecoveries: number;
  }> {
    const { edited, editsSinceCheck, progressed } = await this.runEditTurn(
      res,
      {
        edited: carry.edited,
        editsSinceCheck: carry.editsSinceCheck,
        checkEvery: carry.checkEvery,
      },
      turn,
      turnStart,
      sendStart
    );

    // WS-C: the model raised its hand via ask_user (runOneToolCall set this). END the
    // send now — the question was already surfaced as an `ask_user` event; the REPL
    // shows it and the human's next `send` carries the answer. A `responded` result is
    // the normal "the model produced output, your turn" signal the REPL already handles.
    if (this.state.pendingAskUser !== undefined) {
      const question = this.state.pendingAskUser;

      this.state.pendingAskUser = undefined;

      return {
        action: {
          status: "responded",
          turns: turn,
          awaitingUser: question,
        },
        edited,
        editsSinceCheck,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    const base = { action: "continue" as const, edited, editsSinceCheck };

    if (progressed) {
      return {
        ...base,
        readonlyStreak: 0,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    const readonlyStreak = carry.readonlyStreak + 1;
    const spin = await this.readonlySpinStop(
      readonlyStreak,
      carry.readonlyRecoveries,
      turn
    );

    // Re-steered: reset the streak and spend one recovery, then keep looping so
    // the model gets a fair window to act on the nudge before the next check.
    if (spin === "retry") {
      return {
        ...base,
        readonlyStreak: 0,
        readonlyRecoveries: carry.readonlyRecoveries + 1,
      };
    }

    if (spin !== null) {
      return {
        ...base,
        action: spin,
        readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    return {
      ...base,
      readonlyStreak,
      readonlyRecoveries: carry.readonlyRecoveries,
    };
  }

  /** A working turn (the model emitted tool calls) that also bounds blind
   *  edit-churn: run the calls via `runToolTurn`, track edits since the last full
   *  gate, and force a gate once they cross `FULL_GATE_EVERY` (so the build runs +
   *  the no-progress guards tick even if the model never yields). Returns the
   *  carried loop state, including whether the next turn must force a tool call. */
  private async handleWorkingTurn(
    res: IModelResponse,
    carry: {
      edited: boolean;
      editsSinceCheck: number;
      editsSinceGate: number;
      checkEvery: number;
      readonlyStreak: number;
      readonlyRecoveries: number;
    },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    edited: boolean;
    editsSinceCheck: number;
    editsSinceGate: number;
    readonlyStreak: number;
    readonlyRecoveries: number;
    forceTool: boolean;
  }> {
    const editsBefore = this.state.edits;
    const r = await this.runToolTurn(
      res,
      {
        edited: carry.edited,
        editsSinceCheck: carry.editsSinceCheck,
        checkEvery: carry.checkEvery,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
      },
      turn,
      turnStart,
      sendStart
    );

    let editsSinceGate =
      carry.editsSinceGate + (this.state.edits - editsBefore);
    const carried = {
      edited: r.edited,
      editsSinceCheck: r.editsSinceCheck,
      readonlyStreak: r.readonlyStreak,
      readonlyRecoveries: r.readonlyRecoveries,
    };

    if (r.action !== "continue") {
      return { ...carried, editsSinceGate, action: r.action, forceTool: false };
    }

    // Only force a gate when one is configured. With no gate the "gate" is empty
    // and trivially passes → forcing it would wrongly return done mid-edit, before
    // the model yields its final response (a no-gate session never terminates on a
    // gate). The churn guard exists to surface gate failures, so it's a no-op here.
    if (this.hasGate && editsSinceGate >= forcedGateInterval(this.state)) {
      editsSinceGate = 0;

      const forced = await this.gateAfterChurn(turn, turnStart, sendStart);

      return forced !== null
        ? { ...carried, editsSinceGate, action: forced, forceTool: false }
        : { ...carried, editsSinceGate, action: "continue", forceTool: true };
    }

    return { ...carried, editsSinceGate, action: "continue", forceTool: false };
  }

  /** Resolve a turn where the model yielded with NO tool calls: a conversational
   *  reply, the narrate-instead-of-build failure (resolveNoEditYield), or a gate
   *  confirm after edits. Returns a terminal `ISendResult` or "continue", plus the
   *  next-turn `buildNudges`/`forceTool` state for the caller to carry. Side effects
   *  (repair flag, nudge messages, timing) happen here so `drive`'s loop stays lean. */
  private async resolveYield(
    res: IModelResponse,
    edited: boolean,
    buildNudges: number,
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    buildNudges: number;
    forceTool: boolean;
  }> {
    // With no gate it's a conversational reply; with a gate but no edits this send,
    // decide whether that's a real answer or the narrate-instead-of-build failure.
    if (!this.hasGate || !edited) {
      const outcome = this.resolveNoEditYield(res.content, turn, buildNudges);

      emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

      if (outcome.result !== null) {
        return { action: outcome.result, buildNudges, forceTool: false };
      }

      // It just narrated code — force a tool call next turn.
      return {
        action: "continue",
        buildNudges: buildNudges + 1,
        forceTool: true,
      };
    }

    // Gate confirms. Green/stuck ⇒ terminal; null ⇒ red, feedback pushed.
    const settled = await this.settleTurn(turn, turnStart, sendStart);

    if (settled !== null) {
      return { action: settled, buildNudges, forceTool: false };
    }

    // Gate came back RED → enter repair mode (think to converge on the fix), nudge
    // it to act (not narrate), and FORCE a tool call next turn so it can't narrate.
    this.repairing = true;
    this.ctx.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });

    return { action: "continue", buildNudges, forceTool: true };
  }

  /** Force the full gate mid-edit when the model has churned `FULL_GATE_EVERY`
   *  edits without yielding (it would otherwise never run the build or tick the
   *  no-progress guards). Terminal result (done/stuck) or null when still red —
   *  settleGate has already pushed the gate errors into the conversation, so the
   *  caller just forces the model to act on them. */
  private async gateAfterChurn(
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<ISendResult | null> {
    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚙ forcing a gate after ${String(forcedGateInterval(this.state))} edits without a checkpoint`,
    });

    const forced = await this.settleTurn(turn, turnStart, sendStart);

    if (forced === null) {
      this.repairing = true;
    }

    return forced;
  }

  /** Run the gate once the model has stopped after editing: a terminal result
   *  (done/stuck) or null when still red (drive then pushes feedback + continues).
   *  Keeps the done/stuck mapping out of `drive`'s loop body. */
  private async settleTurn(
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<ISendResult | null> {
    const settled = await settleGate(this.ctx, this.state, turn);

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    if (settled === null) {
      return null;
    }

    // Thread the structured handoff up so BoringStack/interactive callers can park &
    // revisit on ladder exhaustion (host.send reads .handoff). Dropping it here made
    // gate-ladder exhaustion silently un-parkable.
    return {
      status: settled.status === RUN_STATUS.done ? "done" : "stuck",
      turns: turn,
      ...(settled.handoff !== undefined ? { handoff: settled.handoff } : {}),
    };
  }

  /** Drive one send to a terminal result, then mine the send's events for
   *  failure→fix lessons (best-effort, never affects the result). The buffer is
   *  reset per send so each maps to one "run". */
  private async drive(
    maxTurns: number,
    checkpointIntervalTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    this.sendEvents.length = 0;

    try {
      return await this.driveInner(
        maxTurns,
        checkpointIntervalTurns,
        sendStart,
        opts
      );
    } finally {
      await this.consolidateLessons();
    }
  }

  /** Mine the current send's events into the project's learned-rules memory. */
  private async consolidateLessons(): Promise<void> {
    try {
      const candidates = mineLessons(this.sendEvents);
      const consolidate = this.cfg.consolidateLessons ?? consolidateMemory;
      const active = await consolidate(this.ctx.cwd, candidates, MEMORY_RUN_ID);

      if (active > 0) {
        this.report({
          kind: "ttsr",
          task: SESSION_ID,
          message: `memory: ${String(active)} learned rule(s) active in .tsforge/learned-rules.json`,
        });
      }
    } catch (err) {
      // Memory is supplementary — never let it break a send.
      trace("session.memory", err);
    }
  }

  /** The `ttsrManager` completion option, or nothing when TTSR is off. */
  private ttsrCallOption():
    { ttsrManager: TtsrManager } | Record<string, never> {
    return this.ttsrManager === null ? {} : { ttsrManager: this.ttsrManager };
  }

  /** Apply a mid-stream TTSR fire (inject guidance, retry). Returns true when it
   *  fired (the caller should `continue`). */
  private handleTtsrFired(
    res: IModelResponse,
    turn: number,
    turnStart: number,
    sendStart: number
  ): boolean {
    if (res.ttsrFired === undefined) {
      return false;
    }

    applyTtsrInterrupt(
      res.ttsrFired,
      this.state,
      this.ctx.messages,
      this.report,
      SESSION_ID,
      this.ttsrManager
    );
    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    return true;
  }

  /** Handle a degenerate stream: a bounded recovery or a terminal stop. Returns a
   *  stop result, "retry" to continue with a forced tool, or null if not degenerate. */
  private degenerationStop(
    res: IModelResponse,
    degenerations: number,
    turn: number,
    turnStart: number,
    sendStart: number
  ): ISendResult | "retry" | null {
    if (res.degenerated !== true) {
      return null;
    }

    const stop = this.degenerationRecovery(degenerations, turn);

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    return stop ?? "retry";
  }

  /** Handle a read-only spin: the model keeps calling tools but never touches an
   *  editable file, so the gate-based progress guards never get a cycle to judge
   *  and the run would otherwise grind to the turn backstop. Re-steer toward a
   *  concrete change (build) or an answer (conversational) a bounded number of
   *  times, then stop honestly. Returns a stop result, "retry" to re-steer +
   *  continue, or null when the streak is still under the limit. The caller resets
   *  the streak on "retry" so each re-steer gets a fair window before the next. */
  /** The CONCRETE outstanding gate failure(s) to inject into a read-only-spin
   *  re-steer. Observed: the model runs `bun run build`, sees exit 0, declares
   *  "done", and spins re-verifying — never acting on the gate's REAL unmet
   *  requirement (e.g. entity-coverage: 3 entities have no UI). A passing build is
   *  NOT the gate; naming the actual red turns the spin into targeted work. */
  private outstandingGateNote(): string {
    const errs = this.state.prevGateErrors;

    if (errs.length === 0) {
      return "";
    }

    // Show EVERY outstanding gate error — the model can't finish work it can't
    // see. The ceiling is only a runaway backstop for a degenerate cascade, not
    // a feedback limit (was 5, which hid most errors and caused whack-a-mole).
    const MAX_GATE_ERRORS_SHOWN = 200;
    const lines = errs
      .slice(0, MAX_GATE_ERRORS_SHOWN)
      .map((e) => `  - ${e.message}`)
      .join("\n");
    const more =
      errs.length > MAX_GATE_ERRORS_SHOWN
        ? `\n  …and ${String(errs.length - MAX_GATE_ERRORS_SHOWN)} more`
        : "";

    return (
      `\n\nA passing \`bun run build\` is NOT the gate. The gate is still RED — ` +
      `do the OUTSTANDING work now, do not re-verify the build:\n${lines}${more}`
    );
  }

  private async readonlySpinStop(
    streak: number,
    recoveries: number,
    turn: number
  ): Promise<ISendResult | "retry" | null> {
    if (streak < READONLY_STREAK_LIMIT) {
      return null;
    }

    if (recoveries >= MAX_READONLY_RECOVERIES) {
      // This is a "stuck" exit too, so the EXPERT handoff gets its shot HERE before
      // we give up — build v3 died on exactly this path (256 turns of read-only
      // spinning) without ever reaching the expert, because the rescue was only
      // wired to settleGate's stalled-park. If a stronger model repairs the blocking
      // file, keep looping instead of stopping.
      if (
        this.hasGate &&
        (await tryExpertRescue(this.ctx, this.state, this.state.prevGateErrors))
      ) {
        return "retry";
      }

      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const handoff = buildSyntheticHandoff(
        "readonly-spin",
        errorMessages,
        "model called only read-only tools without making progress"
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ model kept calling read-only tools without making progress after " +
          "re-steering — stopped. Narrow the task or steer toward a concrete step.",
      });

      return { status: "stuck", turns: turn, handoff };
    }

    const gateNote = this.hasGate ? this.outstandingGateNote() : "";

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: this.hasGate
        ? `⚠ only reading, no edits — steering toward a concrete change${gateNote.length > 0 ? ` (re-pointed at ${String(this.state.prevGateErrors.length)} outstanding gate error(s))` : ""}`
        : "⚠ only reading, no answer — steering toward a reply",
    });
    this.ctx.messages.push({
      role: "user",
      content: this.hasGate
        ? READONLY_RESTEER_BUILD + gateNote
        : READONLY_RESTEER_ANSWER,
    });

    return "retry";
  }

  private async driveInner(
    maxTurns: number,
    checkpointIntervalTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    const { report } = this;
    // The gate confirms CHANGES, not answers: it fires only once the model has
    // actually edited a file this turn. So a pure question never triggers a gate
    // run (even with one configured) — and an auto-detected gate stays unobtrusive.
    let edited = false;
    // How many times this send the model dumped file contents as a chat message
    // instead of calling `create` (the narrate-instead-of-build failure).
    let buildNudges = 0;
    // Set after we nudge a narrating model: on the NEXT turn we FORCE a tool call
    // (tool_choice "required") instead of "auto". vLLM's required path follows the
    // tool schema strictly — so the model can't narrate (or emit malformed tool
    // syntax) again on a turn where we already know a tool call is the move.
    let forceTool = false;
    // Times the stream degenerated into a repetition loop this send — we try a
    // bounded recovery (force a concrete tool call) before giving up.
    let degenerations = 0;
    // Times a model request timed out this send — a single over-long turn must not
    // throw away prior progress; we re-steer to a small turn and continue.
    let timeouts = 0;
    // Consecutive tool-call turns this send that touched NO editable file (the
    // read-only spin), and how many times we've re-steered out of one. The
    // gate-based guards can't see this — they only fire after a write.
    let readonlyStreak = 0;
    let readonlyRecoveries = 0;
    // Edits since the last incremental check — drives "check every few edits".
    let editsSinceCheck = 0;
    // Edits since the last FULL gate — forces a gate when the model edit-churns
    // without yielding (see FULL_GATE_EVERY), so the build runs + the guards tick.
    let editsSinceGate = 0;
    const checkEvery = this.cfg.checkEvery ?? CHECK_EVERY;

    // Each drive (a send, or a staged build PHASE) converges independently, so the
    // net-progress watermark must start fresh — otherwise phase 2 inherits phase 1's
    // low error count and the guard misfires (its errors never beat the old best).
    this.state.bestErrorCount = Number.POSITIVE_INFINITY;
    this.state.noNewLow = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const turnStart = performance.now();

      // Heartbeat: emit a checkpoint progress event every checkpointIntervalTurns
      // without terminating — allows checkpoint persistence + monitoring.
      emitCheckpoint(report, SESSION_ID, turn, checkpointIntervalTurns);

      // Inject any messages the user typed while the run was in flight, so they
      // steer the next model turn instead of waiting for the run to finish.
      this.injectSteer(opts.steer);

      report({
        kind: "cycle",
        task: SESSION_ID,
        cycle: turn,
        message: `turn ${turn}: asking model`,
      });

      // Ask the model, recovering from a request timeout (re-steer + continue,
      // keeping prior turns) instead of abandoning the whole build on one over-long
      // turn. A caller abort or any other error propagates to send()'s handler.
      const ask = await this.acquireResponse(
        forceTool,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts
      );

      if (ask.kind === "stop") {
        return ask.result;
      }

      if (ask.kind === "retry") {
        timeouts += 1;
        forceTool = true; // next turn: forced, thinking-off → a small clean call

        continue;
      }

      const res = ask.res;

      forceTool = false;

      // A learned/built-in TTSR rule fired mid-stream — inject its corrective
      // guidance and retry (checked before degeneration so the fix lands first).
      // This is how memory's failure→fix lessons reach an interactive session.
      if (this.handleTtsrFired(res, turn, turnStart, sendStart)) {
        continue;
      }

      // The stream caught a degenerate repetition loop. Bounded recovery (force a
      // concrete tool call next turn) before giving up; see degenerationRecovery.
      const deg = this.degenerationStop(
        res,
        degenerations,
        turn,
        turnStart,
        sendStart
      );

      if (deg === "retry") {
        degenerations += 1;
        forceTool = true;

        continue;
      }

      if (deg !== null) {
        return deg;
      }

      // Still working — run the calls, apply the read-only-spin guard, and keep
      // going (we gate only when it stops). The guard's bookkeeping lives in
      // runToolTurn so this loop body stays lean.
      if (res.toolCalls.length > 0) {
        const w = await this.handleWorkingTurn(
          res,
          {
            edited,
            editsSinceCheck,
            editsSinceGate,
            checkEvery,
            readonlyStreak,
            readonlyRecoveries,
          },
          turn,
          turnStart,
          sendStart
        );

        edited = w.edited;
        editsSinceCheck = w.editsSinceCheck;
        editsSinceGate = w.editsSinceGate;
        readonlyStreak = w.readonlyStreak;
        readonlyRecoveries = w.readonlyRecoveries;
        forceTool = w.forceTool;

        if (w.action !== "continue") {
          return w.action;
        }

        continue;
      }

      // The model yielded with no tool calls: a conversational reply, the
      // narrate-instead-of-build failure, or a gate confirm. resolveYield maps it
      // to a terminal result or "continue" (carrying the next forceTool/nudge
      // state), keeping this loop body lean.
      const y = await this.resolveYield(
        res,
        edited,
        buildNudges,
        turn,
        turnStart,
        sendStart
      );

      buildNudges = y.buildNudges;
      forceTool = y.forceTool;
      // A yield runs the gate (when edited), so the churn counter starts fresh.
      editsSinceGate = 0;

      if (y.action !== "continue") {
        return y.action;
      }
    }

    report({
      kind: "stuck",
      task: SESSION_ID,
      cycles: maxTurns,
      message: `stuck (hit the ${maxTurns}-turn runaway crash-guard — progress guards never tripped, which is anomalous; re-steer or narrow the task)`,
    });

    return {
      status: "stuck",
      turns: maxTurns,
    };
  }
}

/** Emit a checkpoint heartbeat event on cadence. */
function emitCheckpoint(
  report: Reporter,
  taskId: string,
  turn: number,
  interval: number
): void {
  if (turn > 1 && turn % interval === 0) {
    report({
      kind: "checkpoint",
      task: taskId,
      cycle: turn,
      message: `checkpoint: turn ${turn}`,
    });
  }
}
