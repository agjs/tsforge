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
  ISplitScore,
  ISplits,
  IValidationResult,
} from "./self-harness.types";

/** Judge scores are 1–5 and noisy; only a drop beyond this is a regression. */
const QUALITY_TOLERANCE = 0.5;
/** Held-out solutions may grow at most this factor before the edit reads as
 *  buying passes with slop. */
const LOC_TOLERANCE_FACTOR = 1.25;
/** Efficiency tie-break (pass counts identical on BOTH splits): held-in
 *  commonly-green cycles must improve by at least this fraction AND this many
 *  absolute cycles (noise floor at repeats=1)… */
const EFFICIENCY_MIN_REL = 0.2;
const EFFICIENCY_MIN_ABS = 2;
/** …while held-out commonly-green cycles may grow at most this fraction. */
const EFFICIENCY_HO_TOLERANCE = 0.1;

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

/** Summed avgTurnsToGreen over tasks green in BOTH evaluations of one split —
 *  the only apples-to-apples efficiency comparison (a task green on one side
 *  only would smuggle a pass delta into a cycle delta). */
function commonGreenCycles(
  base: ISplitScore,
  cand: ISplitScore
): { base: number; cand: number; tasks: number } {
  let baseSum = 0;
  let candSum = 0;
  let tasks = 0;

  for (const [task, summary] of Object.entries(base.perTask)) {
    const candTurns = cand.perTask[task]?.avgTurnsToGreen;

    if (
      summary.avgTurnsToGreen !== null &&
      candTurns !== null &&
      candTurns !== undefined
    ) {
      baseSum += summary.avgTurnsToGreen;
      candSum += candTurns;
      tasks += 1;
    }
  }

  return { base: baseSum, cand: candSum, tasks };
}

/** Held-out quality + concision guards; null = no objection. */
function heldOutGuards(
  baseline: IHarnessEval,
  candidate: IHarnessEval,
  deltaIn: number,
  deltaOut: number
): IAcceptanceDecision | null {
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

  return null;
}

/** The efficiency tie-break, reached ONLY at Δin=0 ∧ Δho=0: equal pass counts
 *  may still promote an edit that makes the harness materially FASTER to green
 *  — the signal the paper's pass-only metric can't see. Pass regression never
 *  reaches here; nothing about the pass rule is loosened. */
function efficiencyDecision(
  baseline: IHarnessEval,
  candidate: IHarnessEval,
  guard: IAcceptanceDecision | null
): IAcceptanceDecision {
  const heldIn = commonGreenCycles(baseline.heldIn, candidate.heldIn);
  const heldOut = commonGreenCycles(baseline.heldOut, candidate.heldOut);
  const gain = heldIn.base - heldIn.cand;
  const material =
    heldIn.tasks > 0 &&
    heldIn.base > 0 &&
    gain >= EFFICIENCY_MIN_ABS &&
    gain / heldIn.base >= EFFICIENCY_MIN_REL;

  if (!material) {
    return {
      accepted: false,
      deltaIn: 0,
      deltaOut: 0,
      reason:
        "no strict gain on either split (Δin=0, Δho=0) and no material efficiency gain",
    };
  }

  if (
    heldOut.tasks > 0 &&
    heldOut.cand > heldOut.base * (1 + EFFICIENCY_HO_TOLERANCE)
  ) {
    return {
      accepted: false,
      deltaIn: 0,
      deltaOut: 0,
      reason: `held-out efficiency regressed (${heldOut.cand.toFixed(1)} > ${heldOut.base.toFixed(1)} cycles × ${String(1 + EFFICIENCY_HO_TOLERANCE)})`,
    };
  }

  if (guard !== null) {
    return guard;
  }

  const rel = Math.round((gain / heldIn.base) * 100);

  return {
    accepted: true,
    deltaIn: 0,
    deltaOut: 0,
    reason: `efficiency gain: held-in ${heldIn.base.toFixed(1)}→${heldIn.cand.toFixed(1)} cycles (−${String(rel)}%), held-out ${heldOut.base.toFixed(1)}→${heldOut.cand.toFixed(1)}`,
  };
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

  const guard = heldOutGuards(baseline, candidate, deltaIn, deltaOut);

  if (deltaIn === 0 && deltaOut === 0) {
    return efficiencyDecision(baseline, candidate, guard);
  }

  if (guard !== null) {
    return guard;
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
