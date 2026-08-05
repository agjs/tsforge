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
  ISplitScore,
  IHarnessOverlay,
  ISplits,
  IValidationResult,
} from "./self-harness.types";

/** Judge scores are 1–5 and noisy; only a drop beyond this is a regression. */
const QUALITY_TOLERANCE = 0.5;
/** Held-out solutions may grow at most this factor before the edit reads as
 *  buying passes with slop. */
const LOC_TOLERANCE_FACTOR = 1.25;
/**
 * The graded criterion, used when pass counts are unchanged on both splits.
 *
 * Replaces an efficiency tie-break on commonly-green CYCLES, which was measured
 * accepting noise: on 2026-08-04 it took seven edits, and the lineage's own
 * re-measurement of the very next round contradicted them (a claimed −49%
 * delivered −11% when the merged overlay was measured fresh). Cycle counts swing
 * 4-10 on a single task, so a 20% threshold sat inside the noise.
 *
 * Progress is a fraction of starting gate errors resolved per run, so it is
 * bounded, comparable across tasks, and moves for reasons the pass bit cannot
 * see — a run going from 50 residual errors to 1 is a real improvement that
 * pass/fail scores as nothing.
 */
const PROGRESS_MIN_GAIN = 0.05;
/*
 * There is deliberately no headroom-relative relaxation of that floor.
 *
 * On a nearly-green split every passing run contributes 1.0, so the most a
 * candidate can gain is roughly failed/total, and the graded dimension goes
 * quiet. Scaling the bar down to keep it talking — it briefly fell to 0.005 —
 * means accepting half-a-point moves, which is the measurement noise this whole
 * change exists to exclude. Going quiet when there is nothing to measure is the
 * correct behaviour; the fix for a corpus with no headroom is harder tasks, not
 * a lower bar.
 */
/** Held-out progress may not fall AT ALL. The paper's rule is non-regression on
 *  the held-out split; a tolerance here would permit promoting a candidate with
 *  measurably worse held-out behaviour, which is precisely what that split
 *  exists to catch. Noise is handled by requiring a material held-in GAIN, not
 *  by forgiving held-out losses. */
const PROGRESS_HO_TOLERANCE = 0;
/**
 * Held-out commonly-green cycles may not blow up past this factor.
 *
 * A BLOWUP GUARD, not an acceptance signal — that distinction is the point.
 * Cycles as a signal accepted noise (a claimed −49% delivered −11% on
 * re-measurement), which is why they no longer decide anything. But dropping
 * them entirely left held-out free to get arbitrarily slower as long as its
 * progress held, and a harness that reaches the same place while thrashing for
 * twice as long is worse.
 *
 * Kept at the 1.1× the previous rule used, and applied to a wider population:
 * every task shared by both evaluations rather than only those green on both
 * sides, so it now fires on the path where the old bar compared nothing.
 *
 * A looser bar was tried and rejected twice on review, correctly. The argument
 * for it — that cycles swing 4-10 on a task, so 10% of a noisier sum sits
 * inside the jitter and will false-reject real gains — is a theory, and the
 * house rule against relaxing a threshold is not. If it does false-reject in
 * practice, that will show up as candidates dying on this veto with flat
 * held-out progress, which is a measurable thing to come back with. Loosening
 * a bar on a prediction is how the loop accepted noise in the first place.
 */
const HO_CYCLE_BLOWUP_FACTOR = 1.1;

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

/** Summed avgCycles over tasks present in BOTH evaluations of one split.
 *
 *  Cycles spent, green or not. The green-only version of this guard did not run
 *  where it was needed: on the path this whole feature exists for — equal pass
 *  counts, progress driven by residual-error reduction — there are few or no
 *  commonly-green tasks, so the comparison had zero tasks and silently passed
 *  everything. A candidate could thrash for arbitrarily long and still clear the
 *  progress bar. Counting every run's cycles makes the guard actually fire. */
function commonCycles(
  base: ISplitScore,
  cand: ISplitScore
): { base: number; cand: number; tasks: number } {
  let baseSum = 0;
  let candSum = 0;
  let tasks = 0;

  for (const [task, summary] of Object.entries(base.perTask)) {
    const candCycles = cand.perTask[task]?.avgCycles;

    if (candCycles !== undefined) {
      baseSum += summary.avgCycles;
      candSum += candCycles;
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

/**
 * A usable graded figure: present, finite, and inside the range it claims.
 *
 * `HarnessEvaluator` is a runtime boundary — injectable, and in production fed
 * by arithmetic over measured counts — so the type says `number` and nothing
 * enforces it. Checking only for undefined let NaN through, and NaN makes EVERY
 * comparison below false: the minimum-gain check does not reject it and neither
 * does the regression check, so a candidate whose held-in score was not a number
 * sailed past both and was accepted. Out-of-range values are the same class of
 * problem with a quieter symptom.
 */
function scored(value: number | undefined): value is number {
  return (
    value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

/**
 * The graded decision, reached when pass counts are identical on both splits.
 *
 * Asks whether the candidate got FURTHER, not merely whether it arrived: mean
 * fraction of starting gate errors resolved per run. A held-in gain must clear
 * the noise floor, and held-out progress must not fall — otherwise an edit can
 * buy held-in progress by damaging generalisation, which is the failure the
 * paper's held-out split exists to catch.
 */
function progressDecision(
  baseline: IHarnessEval,
  candidate: IHarnessEval,
  guard: IAcceptanceDecision | null
): IAcceptanceDecision {
  const inBase = baseline.heldIn.avgProgress;
  const inCand = candidate.heldIn.avgProgress;
  const outBase = baseline.heldOut.avgProgress;
  const outCand = candidate.heldOut.avgProgress;
  const no = (reason: string): IAcceptanceDecision => ({
    accepted: false,
    deltaIn: 0,
    deltaOut: 0,
    reason,
  });

  // FAIL CLOSED on a missing score, on either split. A split with no graded
  // figure is a split that was not measured, and an unmeasured held-out split
  // cannot show non-regression — accepting there would promote an edit on no
  // evidence that it generalises, which is the one thing the held-out split
  // exists to prevent.
  //
  // This governs THIS path only — the graded one. A candidate with a strict pass
  // gain is decided by the paper's rule and never reaches here, so it is still
  // accepted with no graded figure at all. That is deliberate: requiring one
  // would be stricter than Δin ≥ 0 ∧ Δho ≥ 0 ∧ max > 0 and would reject real
  // wins over a measurement that is only the tie-break.
  if (
    !scored(inBase) ||
    !scored(inCand) ||
    !scored(outBase) ||
    !scored(outCand)
  ) {
    return no(
      "no strict gain on either split (Δin=0, Δho=0) and progress was not measured on both splits"
    );
  }

  const pct = (v: number): string => (v * 100).toFixed(1);
  const gain = inCand - inBase;

  // Epsilon, because 0.45 - 0.40 is 0.04999999999999999 in binary floating
  // point and a mathematically valid 5pp gain would be rejected.
  if (gain < PROGRESS_MIN_GAIN - 1e-9) {
    return no(
      `no strict gain on either split (Δin=0, Δho=0) and progress moved only ${pct(inBase)}%→${pct(inCand)}% (needs +${pct(PROGRESS_MIN_GAIN)}pp)`
    );
  }

  // Epsilon here too, for the same reason the other two comparisons carry one:
  // held-out holding exactly level must not read as a regression because the two
  // means differ in the last bit.
  if (outCand < outBase - PROGRESS_HO_TOLERANCE - 1e-9) {
    return no(
      `held-out progress regressed (${pct(outBase)}%→${pct(outCand)}%)`
    );
  }

  // The cycle guard, unconditional at the bar the previous rule used.
  //
  // A waiver was tried — the veto lifted, up to a hard ceiling, when held-out
  // progress improved materially — on the argument that spending more cycles to
  // get FURTHER is the behaviour this feature exists to reward, and that vetoing
  // it makes the graded dimension self-defeating when the baseline fails fast.
  // Reviewers called every version of it a relaxation, and they were right: the
  // waiver made a candidate acceptable that the previous rule rejected, and the
  // reasoning for why that was safe was mine, not evidence. A stricter bar can
  // only cost false REJECTIONS, which for a loop that edits itself is the safe
  // direction to be wrong in. If real candidates start dying here with genuine
  // held-out progress, that is a measurement to bring back — not a prediction.
  const cycles = commonCycles(baseline.heldOut, candidate.heldOut);

  if (cycles.tasks > 0 && cycles.cand > cycles.base * HO_CYCLE_BLOWUP_FACTOR) {
    return no(
      `held-out cycles blew up (${cycles.base.toFixed(1)}→${cycles.cand.toFixed(1)}, past ${String(HO_CYCLE_BLOWUP_FACTOR)}×)`
    );
  }

  if (guard !== null) {
    return guard;
  }

  return {
    accepted: true,
    deltaIn: 0,
    deltaOut: 0,
    reason: `progress gain: held-in ${pct(inBase)}%→${pct(inCand)}% of gate errors resolved, held-out ${pct(outBase)}%→${pct(outCand)}%`,
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
    return progressDecision(baseline, candidate, guard);
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
