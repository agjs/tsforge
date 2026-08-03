import type { IRunRecord, IVariantSummary } from "./eval.types";
import type { IRunMetrics } from "./metrics";

/** One eval run's outcome. */
/** Aggregate run records per variant label. */
export function summarize(records: IRunRecord[]): IVariantSummary[] {
  const byLabel = new Map<string, IRunRecord[]>();

  for (const record of records) {
    const list = byLabel.get(record.label) ?? [];

    list.push(record);
    byLabel.set(record.label, list);
  }

  const summaries: IVariantSummary[] = [];

  for (const [label, list] of byLabel) {
    const passed = list.filter((r) => r.passed).length;
    const total = list.length;
    const sum = (select: (r: IRunRecord) => number): number =>
      list.reduce((acc, r) => acc + select(r), 0);
    const scored = list.filter((r) => r.quality !== undefined);
    const costed = list.filter((r) => r.tokensOut !== undefined);
    const prompted = list.filter((r) => r.tokensIn !== undefined);
    const perChange = list.filter((r) => r.costPerAcceptedChange !== undefined);
    const sized = list.filter((r) => r.loc !== undefined);
    // Turns-to-green only counts runs that actually reached green — averaging in
    // failed runs' (capped) turn counts would muddy the loop-efficiency signal.
    const green = list.filter((r) => r.passed);
    const failureClasses: Record<string, number> = {};

    for (const r of list) {
      const fc = r.failureClass;

      if (!r.passed && fc !== undefined && fc !== "none") {
        failureClasses[fc] = (failureClasses[fc] ?? 0) + 1;
      }
    }

    summaries.push({
      label,
      runs: total,
      passed,
      passRate: passed / total,
      avgCycles: sum((r) => r.cycles) / total,
      avgTurnsToGreen:
        green.length > 0
          ? green.reduce((acc, r) => acc + r.cycles, 0) / green.length
          : null,
      avgMs: sum((r) => r.ms) / total,
      // Averaged over the runs that RECORDED a figure, not all runs: dividing by
      // `total` would quietly report a cheaper variant whenever a run errored
      // before spending anything.
      avgTokensOut:
        costed.length > 0
          ? costed.reduce((acc, r) => acc + (r.tokensOut ?? 0), 0) /
            costed.length
          : 0,
      avgTokensIn:
        prompted.length > 0
          ? prompted.reduce((acc, r) => acc + (r.tokensIn ?? 0), 0) /
            prompted.length
          : 0,
      avgCostPerAcceptedChange:
        perChange.length > 0
          ? perChange.reduce(
              (acc, r) => acc + (r.costPerAcceptedChange ?? 0),
              0
            ) / perChange.length
          : 0,
      avgQuality:
        scored.length > 0
          ? scored.reduce((acc, r) => acc + (r.quality ?? 0), 0) / scored.length
          : 0,
      avgLoc:
        sized.length > 0
          ? sized.reduce((acc, r) => acc + (r.loc ?? 0), 0) / sized.length
          : 0,
      failureClasses,
    });
  }

  return summaries;
}

/**
 * The metric half of a run record, built from a run's measured elapsed time and
 * its event-derived metrics. The ONE place the omit rules live, shared by the
 * self-harness evaluator and the `eval:sweep` campaign — they had diverged once
 * already, which is how the primary sweep ended up printing zeros.
 *
 * A run that accepted nothing OMITS `costPerAcceptedChange` rather than reporting
 * 0: the ratio is undefined, and a 0 averaged in makes a variant look cheaper the
 * less of its work survived. Same for `tokensOut` on a run that never reached the
 * model.
 */
export function buildRunRecord(args: {
  label: string;
  passed: boolean;
  cycles: number;
  elapsedMs: number;
  metrics: Pick<
    IRunMetrics,
    "tokensOut" | "tokensIn" | "costPerAcceptedChange"
  >;
}): IRunRecord {
  const { metrics } = args;

  return {
    label: args.label,
    passed: args.passed,
    cycles: args.cycles,
    ms: args.elapsedMs,
    ...(metrics.tokensOut > 0 ? { tokensOut: metrics.tokensOut } : {}),
    ...(metrics.tokensIn > 0 ? { tokensIn: metrics.tokensIn } : {}),
    ...(metrics.costPerAcceptedChange > 0
      ? { costPerAcceptedChange: metrics.costPerAcceptedChange }
      : {}),
  };
}
