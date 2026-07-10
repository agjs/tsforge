/**
 * Proposal Validation (paper §3.4): a candidate edit is promoted ONLY if it
 * improves at least one split without degrading the other:
 *
 *   Δin ≥ 0  ∧  Δho ≥ 0  ∧  max(Δin, Δho) > 0     (on pass counts)
 *
 * plus two held-out quality guards the paper's pass-count rule can't see
 * (tsforge's gate is code-quality-blind past green): an edit must not buy
 * pass-rate with materially worse judged quality or materially more code.
 */
import { isEmptyPatch, mergeOverlay } from "./overlay";
import type { IMinedRun } from "./mine";
import type {
  ICandidate,
  IHarnessEval,
  IHarnessOverlay,
  ISplits,
  IValidationResult,
} from "./self-harness.types";

/** Judge scores are 1–5 and noisy; only a drop beyond this is a regression. */
const QUALITY_TOLERANCE = 0.5;
/** Held-out solutions may grow at most this factor before the edit reads as
 *  buying passes with slop. */
const LOC_TOLERANCE_FACTOR = 1.25;

/** What one full evaluation of a harness variant yields: the per-split score
 *  plus the held-in run traces (the mining substrate). Injectable so the loop
 *  is testable without a live model. */
export interface IEvaluationOutput {
  readonly evaluation: IHarnessEval;
  readonly heldInRuns: readonly IMinedRun[];
}

export type HarnessEvaluator = (
  overlay: IHarnessOverlay | null,
  splits: ISplits,
  label: string
) => Promise<IEvaluationOutput>;

export interface IAcceptanceDecision {
  readonly accepted: boolean;
  readonly reason: string;
  readonly deltaIn: number;
  readonly deltaOut: number;
}

/** The pure acceptance rule over a baseline and a candidate evaluation. */
export function acceptanceDecision(
  baseline: IHarnessEval,
  candidate: IHarnessEval
): IAcceptanceDecision {
  const deltaIn = candidate.heldIn.passed - baseline.heldIn.passed;
  const deltaOut = candidate.heldOut.passed - baseline.heldOut.passed;

  if (deltaIn < 0 || deltaOut < 0) {
    return {
      accepted: false,
      deltaIn,
      deltaOut,
      reason: `regresses ${deltaIn < 0 ? "held-in" : "held-out"} pass count (Δin=${String(deltaIn)}, Δho=${String(deltaOut)})`,
    };
  }

  if (deltaIn === 0 && deltaOut === 0) {
    return {
      accepted: false,
      deltaIn,
      deltaOut,
      reason: "no strict gain on either split (Δin=0, Δho=0)",
    };
  }

  // Quality guard: only when BOTH sides carry a judge signal.
  const bq = baseline.heldOut.avgQuality;
  const cq = candidate.heldOut.avgQuality;

  if (bq > 0 && cq > 0 && cq < bq - QUALITY_TOLERANCE) {
    return {
      accepted: false,
      deltaIn,
      deltaOut,
      reason: `held-out quality regressed (${cq.toFixed(1)} < ${bq.toFixed(1)} − ${String(QUALITY_TOLERANCE)})`,
    };
  }

  // Concision guard: only when BOTH sides measured green solutions.
  const bl = baseline.heldOut.avgLoc;
  const cl = candidate.heldOut.avgLoc;

  if (bl > 0 && cl > 0 && cl > bl * LOC_TOLERANCE_FACTOR) {
    return {
      accepted: false,
      deltaIn,
      deltaOut,
      reason: `held-out solutions grew past the concision guard (${cl.toFixed(0)} loc > ${bl.toFixed(0)} × ${String(LOC_TOLERANCE_FACTOR)})`,
    };
  }

  return {
    accepted: true,
    deltaIn,
    deltaOut,
    reason: `non-regressive with strict gain (Δin=${String(deltaIn)}, Δho=${String(deltaOut)})`,
  };
}

/**
 * Validate one candidate: apply its patch to the current overlay, evaluate the
 * resulting harness on both splits, and apply the acceptance rule. A candidate
 * that edits nothing or whose evaluation errors out is rejected — never
 * promoted on a missing result.
 */
export async function validateCandidate(
  candidate: ICandidate,
  current: IHarnessOverlay,
  baseline: IHarnessEval,
  splits: ISplits,
  evaluator: HarnessEvaluator
): Promise<IValidationResult> {
  if (isEmptyPatch(candidate.patch)) {
    return {
      candidate,
      accepted: false,
      reason: "patch modifies no editable surface",
      deltaIn: 0,
      deltaOut: 0,
    };
  }

  const merged = mergeOverlay(current, candidate.patch);
  let output: IEvaluationOutput;

  try {
    output = await evaluator(merged, splits, candidate.id);
  } catch (err) {
    return {
      candidate,
      accepted: false,
      reason: `evaluation errored before a valid result (${err instanceof Error ? err.message : String(err)})`,
      deltaIn: 0,
      deltaOut: 0,
    };
  }

  // Runs that crashed on infrastructure (endpoint timeout/unreachable) make
  // the deltas meaningless — reject on the honest ground that no valid result
  // was obtained, never as a phantom "regression" blamed on the edit.
  const erroredRuns =
    output.evaluation.heldIn.errored + output.evaluation.heldOut.errored;

  if (erroredRuns > 0) {
    return {
      candidate,
      accepted: false,
      reason: `no valid evaluation result — ${String(erroredRuns)} run(s) hit infrastructure errors (endpoint timeout/unreachable)`,
      deltaIn: 0,
      deltaOut: 0,
      candidateEval: output.evaluation,
    };
  }

  const decision = acceptanceDecision(baseline, output.evaluation);

  return { candidate, ...decision, candidateEval: output.evaluation };
}
