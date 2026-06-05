/** One eval run's outcome. */
export interface IRunRecord {
  /** Variant label (e.g. "temp=0"). */
  label: string;
  passed: boolean;
  cycles: number;
  ms: number;
  /** LLM-judge quality score (1–5), when available. */
  quality?: number;
}

/** Aggregated metrics for a variant across its runs. */
export interface IVariantSummary {
  label: string;
  runs: number;
  passed: number;
  passRate: number;
  avgCycles: number;
  avgMs: number;
  /** Average quality across runs that were scored (0 if none). */
  avgQuality: number;
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
    const scored = list.filter((r) => r.quality !== undefined);

    summaries.push({
      label,
      runs: total,
      passed,
      passRate: passed / total,
      avgCycles: sum((r) => r.cycles) / total,
      avgMs: sum((r) => r.ms) / total,
      avgQuality:
        scored.length > 0
          ? scored.reduce((acc, r) => acc + (r.quality ?? 0), 0) / scored.length
          : 0,
    });
  }

  return summaries;
}
