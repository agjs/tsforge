import type { IRunRecord, IVariantSummary } from "./eval.types";
import type { IRunMetrics } from "./metrics";

/**
 * Mean of `select` over the records that RECORDED a value, 0 when none did.
 *
 * The load-bearing part is the FILTER. Dividing by every run would report a
 * variant as cheaper (or faster, or better) the more often it recorded nothing —
 * a crash before the first model call would improve its numbers.
 */
function meanOfRecorded(
  list: readonly IRunRecord[],
  select: (record: IRunRecord) => number | undefined
): number {
  const values: number[] = [];

  for (const record of list) {
    const value = select(record);

    if (value !== undefined) {
      values.push(value);
    }
  }

  return values.length > 0
    ? values.reduce((acc, v) => acc + v, 0) / values.length
    : 0;
}

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
      // A throw has no meaningful cycle count; averaging its 0 in made avgCycles
      // IMPROVE with the error rate.
      avgCycles: meanOfRecorded(list, (r) =>
        r.errored === true ? undefined : r.cycles
      ),
      // Turns-to-green counts only runs that actually reached green — averaging in
      // failed runs' (capped) counts would muddy the loop-efficiency signal. Null,
      // not 0, when none did: "no data" is not "instant".
      avgTurnsToGreen:
        green.length > 0
          ? green.reduce((acc, r) => acc + r.cycles, 0) / green.length
          : null,
      // Every run reports real elapsed time, including a crash, so this divides by
      // all of them.
      avgMs: sum((r) => r.ms) / total,
      avgTokensOut: meanOfRecorded(list, (r) => r.tokensOut),
      avgTokensIn: meanOfRecorded(list, (r) => r.tokensIn),
      avgCostPerAcceptedChange: meanOfRecorded(
        list,
        (r) => r.costPerAcceptedChange
      ),
      avgQuality: meanOfRecorded(list, (r) => r.quality),
      avgLoc: meanOfRecorded(list, (r) => r.loc),
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
