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
  /** False when the judge produced NO usable score (unparseable / errored). The
   *  caller must treat this as "no signal" — never as a real 0/5 critique to act
   *  on, or it feeds the generator a nonsense "improve this" instruction. */
  scored: boolean;
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
  /** Fraction of the starting gate errors this run resolved, in [0, 1]; 1 for a
   *  pass. The graded signal the pass bit hides — a failed run that clears 49 of
   *  50 errors scores 0.98 rather than being indistinguishable from one that
   *  cleared none. Omitted when the run recorded no gate settlements (an
   *  infrastructure failure, which must not read as progress of zero). */
  progress?: number;
}

/** Aggregated metrics for a variant across its runs. */
export interface IVariantSummary {
  label: string;
  runs: number;
  passed: number;
  passRate: number;
  avgCycles: number;
  /** Average turns to reach green, over PASSED runs only (null if none passed).
   *  The headline loop-efficiency signal — lower means the harness fixes things
   *  in fewer rounds. Distinct from avgCycles, which dilutes with failed runs. */
  avgTurnsToGreen: number | null;
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
