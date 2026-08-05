/**
 * Shared types for the Self-Harness loop (arXiv 2606.09498): a fixed model
 * improves the declarative harness around itself via a regression-gated
 * hill-climb — evaluate → mine weaknesses → propose minimal edits → validate
 * with a non-regression acceptance rule → merge into a per-model overlay.
 */
import type { ITtsrRule } from "../loop/ttsr";
import type { IVariantSummary } from "../eval/eval.types";

/** The named, editable system-prompt anchor points. `bootstrap` = the
 *  lead-with-action instruction, `execution` = the gate-feedback loop
 *  instruction, `verification` = the run-your-hypotheses instruction, and
 *  `extra` = a free slot appended after all built-in blocks (starts empty, so
 *  it is effectively append-only). Everything else in the system prompt —
 *  identity, tool list, gate-rules sentence — is deliberately NOT editable:
 *  the proposer must not be able to redescribe the verifier. */
export const PROMPT_BLOCK_NAMES = [
  "bootstrap",
  "execution",
  "verification",
  "extra",
] as const;

export type PromptBlockName = (typeof PROMPT_BLOCK_NAMES)[number];

/** One edit to a named prompt block: append below it or replace it. */
export interface IPromptBlockEdit {
  readonly mode: "append" | "replace";
  readonly text: string;
}

/** A bounded override of one agent spec — prompt/task/turn-budget only.
 *  `tools` and `model` are deliberately not overridable: an edit must not be
 *  able to grant a subagent new capabilities or reroute it to another model. */
export interface IAgentSpecOverride {
  readonly id: string;
  readonly systemPrompt?: string;
  readonly task?: string;
  readonly maxTurns?: number;
}

/**
 * An edit to how an EXISTING tool is offered to the model: reword its
 * description, or stop offering it.
 *
 * The paper lists `tools` among the editable surfaces of the harness file while
 * holding *"the … tool set … unchanged"* across variants. That asymmetry is the
 * whole guard: an id that names no offered tool does nothing, so there is no
 * path by which an edit grants capability the harness did not already have.
 * Hiding a tool the model needs is allowed and self-correcting — the pass rate
 * falls and the acceptance rule rejects the edit.
 */
export interface IToolOverride {
  /** The tool's advertised name. Must already be offered; unknown ids no-op. */
  readonly id: string;
  readonly description?: string;
  /** `false` stops offering the tool. There is no `true` that adds one. */
  readonly enabled?: boolean;
}

/** A procedure-card override for one gate rule id — merged over the curated /
 *  generated doc at `ruleHelp()` time, field-wise. */
export interface IProcedureCardEdit {
  readonly what?: string;
  readonly bad?: string;
  readonly good?: string;
  readonly procedure?: string;
}

/**
 * The per-model harness overlay: h_t = base harness + overlay. Every field is
 * declarative data, so applying an edit is a JSON merge and reverting is
 * dropping it. There is intentionally NO gate-strictness field — the verifier
 * is not a proposable surface (reward-hacking guard).
 */
export interface IHarnessOverlay {
  readonly version: 1;
  /** Extra TTSR rules (JSON shape: string regex sources). */
  readonly ttsrRules: readonly ITtsrRule[];
  readonly agentSpecOverrides: readonly IAgentSpecOverride[];
  readonly promptBlocks: Partial<Record<PromptBlockName, IPromptBlockEdit>>;
  /** Keyed by the exact rule id the validators emit (e.g. "TS2307"). */
  readonly procedureCards: Record<string, IProcedureCardEdit>;
  /** Re-wiring of tools the harness already offers. */
  readonly toolOverrides: readonly IToolOverride[];
}

/** A candidate edit Δj: a partial overlay to merge onto h_t. */
export type IOverlayPatch = Partial<Omit<IHarnessOverlay, "version">>;

/** One verifier-grounded failure pattern C_φ mined from held-in traces. */
export interface IFailurePattern {
  /** Exact-agreement clustering key: `failureClass|dominantSignal|detail`. */
  readonly signature: string;
  readonly failureClass: string;
  /** The dominant IFailureSignals key (e.g. "editRejects", "tsErrors"). */
  readonly dominantSignal: string;
  /** Dominant rule code when the gate failed (e.g. "TS2307", "no-as"). */
  readonly detail?: string;
  /** Cluster size — how many failed runs share this signature. */
  readonly support: number;
  readonly taskIds: readonly string[];
  /** Gate rule ids / verifier outcomes backing the cluster. */
  readonly verifierEvidence: readonly string[];
  /** Short representative event lines from the ledger. */
  readonly traceSnippets: readonly string[];
  /** Deterministic one-line description of the agent-side mechanism. */
  readonly mechanism: string;
}

/** The evidence bundle B_t handed to the proposer. */
export interface IEvidenceBundle {
  readonly totalRuns: number;
  readonly failedRuns: number;
  /** Passed runs that crossed their slow-green threshold — green, but at a
   *  cycle cost worth improving (the efficiency signal the pass bit hides). */
  readonly slowGreenRuns: number;
  /** Ranked by support, descending. */
  readonly patterns: readonly IFailurePattern[];
}

/** Audit record a_j accompanying each candidate edit. */
export interface ICandidateAudit {
  readonly targetPattern: string;
  readonly surface: string;
  readonly expectedEffect: string;
  readonly risks: string;
}

export interface ICandidate {
  readonly id: string;
  readonly patch: IOverlayPatch;
  readonly audit: ICandidateAudit;
}

/** Held-in / held-out task-id splits. Held-out is never shown to the proposer. */
export interface ISplits {
  readonly heldIn: readonly string[];
  readonly heldOut: readonly string[];
}

/** Aggregate score of one harness variant on one split. */
export interface ISplitScore {
  /** Total passed runs across all tasks × repeats. */
  readonly passed: number;
  readonly runs: number;
  /** Runs that crashed before producing a valid result (endpoint timeout /
   *  connection failure) — counted as not-passed but flagged so a verdict is
   *  never blamed on the edit when the infrastructure failed (paper §3.4:
   *  "fail execution before a valid evaluation result"). */
  readonly errored: number;
  /** Mean of per-task avgQuality over tasks that recorded one (0 if none). */
  readonly avgQuality: number;
  /** Mean of per-task avgLoc over tasks that recorded one (0 if none). */
  readonly avgLoc: number;
  /**
   * Mean fraction of starting gate errors resolved across the split's runs, or
   * undefined when no run recorded one.
   *
   * This is the GRADED score the acceptance rule reads. The pass count alone
   * cannot see a candidate that takes a task from 50 residual errors to 1,
   * which is the state a real failed run was measured in — so on a corpus whose
   * one failing task flips 60/40 by itself, pass-rate acceptance can only ever
   * fire on a fluke. Every edit accepted on 2026-08-04 was one.
   */
  readonly avgProgress?: number;
  readonly perTask: Record<string, IVariantSummary>;
}

export interface IHarnessEval {
  readonly heldIn: ISplitScore;
  readonly heldOut: ISplitScore;
}

/** Outcome of validating one candidate against the acceptance rule. */
export interface IValidationResult {
  readonly candidate: ICandidate;
  readonly accepted: boolean;
  readonly reason: string;
  readonly deltaIn: number;
  readonly deltaOut: number;
  readonly candidateEval?: IHarnessEval;
}

/** One round t of the loop, fully auditable. */
export interface IRoundRecord {
  readonly round: number;
  readonly baseline: IHarnessEval;
  readonly evidence: IEvidenceBundle;
  readonly candidates: readonly IValidationResult[];
  readonly acceptedIds: readonly string[];
}

/** The full harness lineage h_0 → h_T produced by one self-harness run. */
export interface ILineage {
  readonly model: string;
  readonly splits: ISplits;
  readonly rounds: readonly IRoundRecord[];
  readonly finalOverlay: IHarnessOverlay;
  /** No-silent-caps log: every dropped candidate / skipped task / truncation. */
  readonly notes: readonly string[];
}
