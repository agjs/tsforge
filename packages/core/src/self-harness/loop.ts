/**
 * The Self-Harness loop (paper Algorithm 1), tsforge-native. Per round t:
 *   1. EVALUATE h_t on both splits (baseline for this round's deltas).
 *   2. MINE the held-in failures into an evidence bundle (deterministic).
 *   3. PROPOSE K minimal candidate edits (the same fixed model, proposer role).
 *   4. VALIDATE each candidate; ACCEPT iff non-regressive with strict gain.
 *   5. MERGE accepted edits → h_{t+1}; rejected ones are logged, not applied.
 *
 * The loop only ever *builds* an overlay lineage — installation of the final
 * overlay is a human decision on the emitted PR diff (report.ts), never
 * automatic.
 */
import { emptyOverlay, isEmptyPatch, mergeOverlay } from "./overlay";
import { mineWeaknesses } from "./mine";
import { propose } from "./propose";
import { validateCandidate, type HarnessEvaluator } from "./validate";
import type { IProvider } from "../inference";
import type {
  IHarnessOverlay,
  ILineage,
  IRoundRecord,
  ISplits,
  IValidationResult,
} from "./self-harness.types";

export interface ISelfHarnessOptions {
  /** Model id, for the per-model lineage (a DeepSeek harness ≠ a Qwen one). */
  readonly model: string;
  readonly rounds: number;
  readonly width: number;
  readonly splits: ISplits;
  /** The proposer — the SAME fixed model the harness runs under. */
  readonly provider: IProvider;
  /** Evaluates one harness variant on the splits. Injected: the CLI wires the
   *  real corpus evaluator; tests wire a deterministic fake. */
  readonly evaluator: HarnessEvaluator;
  /** Start from an already-promoted overlay to continue a lineage. */
  readonly initialOverlay?: IHarnessOverlay;
  readonly log?: (line: string) => void;
}

function attemptSummary(result: IValidationResult): string {
  const { candidate } = result;

  return `${candidate.id} (${result.accepted ? "ACCEPTED" : "rejected"}): targets ${candidate.audit.targetPattern} via ${candidate.audit.surface} — ${candidate.audit.expectedEffect} [Δin=${String(result.deltaIn)}, Δho=${String(result.deltaOut)}: ${result.reason}]`;
}

export async function runSelfHarness(
  opts: ISelfHarnessOptions
): Promise<ILineage> {
  const log = opts.log ?? ((): void => undefined);
  const notes: string[] = [];
  const priorAttempts: string[] = [];
  const rounds: IRoundRecord[] = [];
  let overlay = opts.initialOverlay ?? emptyOverlay();

  for (let t = 0; t < opts.rounds; t += 1) {
    log(`round ${String(t)}: evaluating h_${String(t)} on both splits…`);

    const base = await opts.evaluator(
      isEmptyPatch(overlay) ? null : overlay,
      opts.splits,
      `r${String(t)}-baseline`
    );

    log(
      `round ${String(t)}: baseline pass held-in ${String(base.evaluation.heldIn.passed)}/${String(base.evaluation.heldIn.runs)}, held-out ${String(base.evaluation.heldOut.passed)}/${String(base.evaluation.heldOut.runs)}`
    );

    const evidence = mineWeaknesses(base.heldInRuns);

    if (evidence.patterns.length === 0) {
      notes.push(
        `round ${String(t)}: no held-in failures to mine — loop stops early`
      );
      rounds.push({
        round: t,
        baseline: base.evaluation,
        evidence,
        candidates: [],
        acceptedIds: [],
      });
      log(`round ${String(t)}: held-in fully green — nothing to improve`);
      break;
    }

    log(
      `round ${String(t)}: mined ${String(evidence.patterns.length)} failure pattern(s); proposing ${String(opts.width)} candidate(s)…`
    );

    const candidates = await propose(evidence, {
      provider: opts.provider,
      width: opts.width,
      current: overlay,
      priorAttempts,
      idPrefix: `r${String(t)}`,
      notes,
    });

    const results: IValidationResult[] = [];

    // Sequential: candidate evaluations share the single-connection endpoint.
    for (const candidate of candidates) {
      log(`round ${String(t)}: validating ${candidate.id}…`);

      const result = await validateCandidate(
        candidate,
        overlay,
        base.evaluation,
        opts.splits,
        opts.evaluator
      );

      results.push(result);
      priorAttempts.push(attemptSummary(result));
      log(
        `round ${String(t)}: ${candidate.id} ${result.accepted ? "ACCEPTED" : "rejected"} — ${result.reason}`
      );
    }

    const accepted = results.filter((r) => r.accepted);

    // MergeAccepted: compatible accepted edits merge in proposal order
    // (paper §3.4); when none pass, h_{t+1} = h_t.
    for (const result of accepted) {
      overlay = mergeOverlay(overlay, result.candidate.patch);
    }

    rounds.push({
      round: t,
      baseline: base.evaluation,
      evidence,
      candidates: results,
      acceptedIds: accepted.map((r) => r.candidate.id),
    });
  }

  return {
    model: opts.model,
    splits: opts.splits,
    rounds,
    finalOverlay: overlay,
    notes,
  };
}
