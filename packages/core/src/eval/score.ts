import type { IRunRecord, IVariantSummary } from "./eval.types";

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
    const sized = list.filter((r) => r.loc !== undefined);
    // Only runs whose endpoint reported a cache figure. Averaging in the silent
    // ones as 0 would report a cold prefix for a server that never said.
    const cached = list.filter((r) => r.cacheHitRate !== undefined);
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
      avgQuality:
        scored.length > 0
          ? scored.reduce((acc, r) => acc + (r.quality ?? 0), 0) / scored.length
          : 0,
      avgLoc:
        sized.length > 0
          ? sized.reduce((acc, r) => acc + (r.loc ?? 0), 0) / sized.length
          : 0,
      avgCacheHitRate:
        cached.length > 0
          ? cached.reduce((acc, r) => acc + (r.cacheHitRate ?? 0), 0) /
            cached.length
          : null,
      failureClasses,
    });
  }

  return summaries;
}
