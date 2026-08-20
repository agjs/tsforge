import type { ErrorParser } from "../validate";
import type { ProfileId } from "../config/profiles";
import type { PolicyMode } from "../policy";
import type { IGate } from "../gate/gate-runner";
import type { MetaBaseline } from "../meta-rules";
import type { FailureClass } from "../eval/failure-class";
import {
  type RUN_STATUS,
  type STUCK_REASON,
  type SPEC_STATUS,
} from "./loop.constants";

/** An escalation rung in the steer ladder (not R0 or R5 — those are not "rungs" to be tried). */
export type EscalationRung = "R1" | "R2" | "R3" | "R4";

/** A structured, resumable handoff when all escalation rungs have been exhausted on a block. */
export interface IHandoff {
  /** The stable identity of the stuck block (fingerprint). */
  block: string;
  /** Ordered levers tried on the final block. */
  rungHistory: EscalationRung[];
  /** Persisting error keys/messages. */
  errors: string[];
  /** What a human / stronger model / more context is needed for. */
  ask: string;
  /** Always true: a handoff is always resumable. */
  resumable: true;
  /** Machine state to resume without re-firing the same levers. Either the tried levers
   *  for the final block, or a ref to the checkpoint holding full ILoopState. */
  resume: { triedLevers: EscalationRung[] } | { checkpointRef: string };
  /** Harness-owned failure class at park time (so resume/human sees our diagnosis). */
  failureClass?: FailureClass;
  /** Dominant rule/code for type-error|lint-rule when known. */
  failureDetail?: string;
}

/** A progress event emitted as the loop runs, for live observability. */
export interface ILoopEvent {
  kind:
    | "start"
    | "red"
    | "cycle"
    | "checkpoint"
    | "token"
    | "message"
    | "fix"
    | "edit"
    | "create"
    | "validated"
    | "done"
    | "stuck"
    | "run"
    | "tool"
    | "repair"
    | "timing"
    | "usage"
    | "ttsr"
    // An edit batch was rolled back because it broke the gate or failed to raise
    // quality (accounting-only; renders to nothing — the human-facing message
    // rides a `fix` event). Feeds the accept-rate / cost-per-accepted-change
    // metrics: the reverted edits were spent but never accepted. Carries `count`
    // = how many mutations the batch rolled back (defaults to 1 if absent).
    | "reverted"
    // A unified-policy verdict for one proposed action (ledger-only; renders to
    // nothing on the terminal — a deny is already surfaced via its `tool` event).
    | "policy"
    // A harness→model injected user message (settle gate feedback with its
    // banners/steers/autofix notice). Ledger-only: `message` carries the FULL
    // injected text so a `--log` run records what the model was actually told —
    // before this, the injected prose had no channel and eval greps could only
    // see gate verdicts. Renders to nothing (the terminal already shows the
    // distilled red/steer lines).
    | "inject"
    // A subagent was ANNOUNCED under this task (queued; message: agent id). All
    // of a fan-out's units spawn up-front so progress denominators are stable
    // and the agent tree can render pending rows before work begins.
    | "agent_spawned"
    // A previously spawned subagent began running (its pending row goes live).
    | "agent_started"
    // A subagent finished; `output` carries its final text/structured payload and
    // `passed` whether it completed (vs failed/aborted).
    | "agent_result"
    // The co-pilot (WS-C) raised its hand: the model called `ask_user` and the turn
    // PAUSED for a human answer. `message` carries the question; the REPL renders it
    // and the human's next send is the reply. Interactive-only (never headless).
    | "ask_user";
  task: string;
  /** Which subagent emitted this event. Absent = the parent/main loop. Set on
   *  every event a subagent emits (not just agent_* kinds), so interleaved
   *  parallel streams stay attributable in the ledger and the agent tree. */
  agentId?: string;
  /** The spawning task's id for agent_* events, so a renderer can build the
   *  parent→children tree without parsing hierarchical id strings. */
  parentTask?: string;
  message: string;
  cycle?: number;
  cycles?: number;
  /** For `reverted` events: how many file mutations the rolled-back batch
   *  contained, so the accept-rate metric subtracts the whole batch, not just 1. */
  count?: number;
  /** For `timing` events: how long the turn took, in milliseconds. */
  ms?: number;
  /** Wall time for a whole model call, prefill included (`ms` is generation only). */
  callMs?: number;
  errors?: number;
  /** For `validated` events: the failing gate rules/codes (e.g. "TS18048",
   *  "no-restricted-syntax") — the structured substrate the failure classifier
   *  reads to tell a type error from a lint rule, not just a count. */
  rules?: readonly string[];
  /** For `validated` events: harness-owned failure class from classifyFromGate. */
  failureClass?: FailureClass;
  /** For `validated` events: dominant rule/code when the class carries one. */
  failureDetail?: string;
  passed?: boolean;
  /** For `stuck` events: a human-readable blocker diagnosis. */
  detail?: string;
  /** For `stuck` events with a handoff: the structured handoff details. */
  handoff?: IHandoff;
  file?: string;
  /** Files a tool MUTATED without the model hand-writing them — semantic ops
   *  (move/rename/organize) and scaffolds. Accounting-only: it tells the loop the
   *  workspace changed (so the gate must run, and these paths join the change
   *  scope) WITHOUT triggering the per-write guard, which must not re-check
   *  generated shells. Emitted only on a real mutation — never on a reject/no-op,
   *  so a rejected op can't be miscounted as a successful one. */
  mutated?: readonly string[];
  /** For `create` events: the new file's content (rendered as a code block). */
  content?: string;
  /** For `edit` events: the replaced / replacement snippets (rendered as a diff). */
  oldString?: string;
  newString?: string;
  /** For `run` events: the shell command and its result. */
  command?: string;
  exitCode?: number;
  output?: string;
  /** For `token` events: which stream it came from. The renderer collapses
   *  `reasoning` to a compact "thinking…" indicator (the full text still goes to
   *  the log); `tool` markers and gate output (no channel) print normally. */
  channel?: "reasoning" | "content" | "tool";
  /** For `usage` events: real per-call token accounting (for the --log metrics). */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** For `usage` events: how much of `promptTokens` the server served from its
   *  prefix cache. Absent when the endpoint doesn't report it — which is NOT the
   *  same as a cold prefix, so the analyzer must not read a missing field as 0.
   *  A ratio that collapses part-way through a run is the harness having broken
   *  its own prompt prefix; without this the same symptom reads as "slow model". */
  cachedPromptTokens?: number;
  /** For `usage` events: output generation rate (completion tokens / second),
   *  measured from the first streamed token to the call's end. */
  tokensPerSecond?: number;
  /** For `usage` (and salvage-warning `tool`) events: whether THIS model call
   *  ran with thinking enabled — lets the analyzer correlate malformed-tool-call
   *  rate with the thinking mode (see analyze-malformed). */
  thinking?: boolean;
  /** For the `start` event: run metadata, so a log is self-describing for the
   *  analyzer (which model / how big a context window the metrics are against). */
  model?: string;
  contextWindow?: number;
  /** For `policy` events: the verdict and risk for one proposed action (the
   *  matched rules ride in `rules`, the reason in `message`). */
  decision?: "allow" | "ask" | "deny";
  risk?: "low" | "medium" | "high" | "critical";
}

export type Reporter = (event: ILoopEvent) => void;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export type StuckReason = (typeof STUCK_REASON)[keyof typeof STUCK_REASON];
export type SpecStatus = (typeof SPEC_STATUS)[keyof typeof SPEC_STATUS];

export interface IRunResult {
  task: string;
  /** The gate failed before we started (a real goalpost). */
  redConfirmed: boolean;
  status: RunStatus;
  /** Model turns used. */
  cycles: number;
  reason?: StuckReason;
  /** When stuck: a human-readable blocker diagnosis (the persistent rule/file +
   *  last error) so an interactive session can hand back something actionable. */
  detail?: string;
  /** When stuck with a handoff: the structured, resumable handoff details. */
  handoff?: IHandoff;
  /** Edits/creates applied to editable files (measure edit churn). */
  edits?: number;
  /** Times an edit RAISED the gate error count (regressions). */
  regressions?: number;
}

export interface IRunOptions {
  parse?: ErrorParser;
  onEvent?: Reporter;
  temperature?: number;
  /** Per-request thinking toggle passed to the provider. */
  enableThinking?: boolean;
  /** Cap reasoning tokens per model call (vLLM `thinking_token_budget`). */
  thinkingTokenBudget?: number;
  /** Runaway crash-guard on model turns (default LOOP_LIMITS.runawayBackstopTurns).
   *  Crossing it logs an anomaly and returns STUCK_REASON.cap with no handoff.
   *  The PRIMARY terminal is ladder-exhaustion (R5 handoff), not this turn cap. */
  maxTurns?: number;
  /** Heartbeat cadence: emit a checkpoint progress event every N turns without
   *  terminating (default LOOP_LIMITS.checkpointIntervalTurns = 40). */
  checkpointIntervalTurns?: number;
  /** Seed the run with a deterministic pre-edit scout bundle (caller blast-radius
   *  of the editable files). Opt-in; only fires on brownfield (existing-code) runs. */
  scout?: boolean;
  /** Require the gate to be RED before building (default true). The normal
   *  contract: a task must fail first, so a no-op can't be mistaken for success.
   *  Set false for greenfield feature builds, where the global gate is a guardrail
   *  (often already green from prior features) rather than the per-feature signal —
   *  the model must still implement the feature, and the per-feature browser/judge
   *  layers decide whether it's done. */
  requireRed?: boolean;
  /** Suppress the post-green agent-review phase for THIS run (the auto review that
   *  fires in `finish()` on a done result). Set by callers that run their OWN review
   *  afterwards — the one-shot `--with-review` path runs `reviewRepair`, so it would
   *  otherwise review twice. Independent of the global TSFORGE_NO_REVIEW toggle. */
  suppressReview?: boolean;
  /** Rule profile override (from a recipe); defaults to tsforge.config.json. */
  profile?: ProfileId;
  /** Policy-mode override (from the `--policy-mode` CLI flag); when set it wins
   *  over `tsforge.config.json`'s `policy.mode` for this run. Without it a
   *  headless/one-shot run ignored the documented flag entirely. */
  policyMode?: PolicyMode;
  /** The composed gate this run's loop checks each cycle. Defaults to a command
   *  gate built from `task.accept` (brownfield behavior). Modes inject a richer
   *  composed gate (command + differential + judge + …) so the escalation ladder
   *  sees the REAL errors. */
  gate?: IGate;
  /** Pristine-scaffold meta-rule baseline subtracted from each cycle's violations,
   *  so a run is graded only on meta violations it INTRODUCES. */
  metaBaseline?: MetaBaseline;
  /** Model context window (tokens). When set with usage from prior turns, the
   *  headless loop auto-compacts mid-drive once prompt tokens cross the threshold. */
  contextWindow?: number;
  /** Fraction of `contextWindow` that triggers mid-drive auto-compaction (default 0.8). */
  autoCompactAt?: number;
}

export interface ISpecResult {
  status: SpecStatus;
  results: IRunResult[];
}
