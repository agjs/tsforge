import type { ErrorParser } from "../validate";
import {
  type RUN_STATUS,
  type STUCK_REASON,
  type SPEC_STATUS,
} from "./loop.constants";

/** A progress event emitted as the loop runs, for live observability. */
export interface ILoopEvent {
  kind:
    | "start"
    | "red"
    | "cycle"
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
    // metrics: a reverted edit was spent but never accepted.
    | "reverted"
    // A unified-policy verdict for one proposed action (ledger-only; renders to
    // nothing on the terminal — a deny is already surfaced via its `tool` event).
    | "policy";
  task: string;
  message: string;
  cycle?: number;
  cycles?: number;
  /** For `timing` events: how long the turn took, in milliseconds. */
  ms?: number;
  errors?: number;
  /** For `validated` events: the failing gate rules/codes (e.g. "TS18048",
   *  "no-restricted-syntax") — the structured substrate the failure classifier
   *  reads to tell a type error from a lint rule, not just a count. */
  rules?: readonly string[];
  passed?: boolean;
  /** For `stuck` events: a human-readable blocker diagnosis. */
  detail?: string;
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
  /** Hard backstop on model turns (default LOOP_LIMITS.maxTurns). */
  maxTurns?: number;
  /** Seed the run with a deterministic pre-edit scout bundle (caller blast-radius
   *  of the editable files). Opt-in; only fires on brownfield (existing-code) runs. */
  scout?: boolean;
}

export interface ISpecResult {
  status: SpecStatus;
  results: IRunResult[];
}
