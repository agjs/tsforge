import type { FailureClass } from "./failure-class";

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
  /** Lines of code in the solution's task files (non-blank, non-comment), measured
   *  post-hoc on a green run. The concision signal the gate is blind to; omitted
   *  for a failed run (there's no shipped solution to measure). */
  loc?: number;
  /** Structured reason a failed run failed (from classifyRun); omitted/`none`
   *  for a passing run. The substrate for turning failures into interventions. */
  failureClass?: FailureClass;
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
  /** Average LOC across runs that recorded it — i.e. green runs (0 if none). The
   *  lower-is-better concision metric, compared per task across variants. */
  avgLoc: number;
  /** Count of failed runs by failure class (e.g. {"type-error": 2}); empty when
   *  no run carried a class. Lets a sweep show WHY a variant failed, not just how
   *  often. */
  failureClasses: Record<string, number>;
}
