export interface IJudgeInput {
  goal: string;
  criteria: string;
  code: string;
}

/** A quality score (1–5 per dimension) from an LLM reviewer — what the gate can't see. */
export interface IJudgeScore {
  overall: number;
  correctness: number;
  design: number;
  readability: number;
  notes: string;
}

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
