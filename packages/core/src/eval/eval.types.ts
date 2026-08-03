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
  /** Completion tokens the run spent. Omitted when the run errored before
   *  producing any. Without it a sweep compares variants on pass-rate alone, so a
   *  variant that passes slightly more often while costing several times as much
   *  reads as a straight win. */
  tokensOut?: number;
  /** Total prompt tokens the run sent. A variant that grows the prompt costs more
   *  per call while producing the same output, so output tokens alone hide it. */
  tokensIn?: number;
  /** The attempt THREW (infrastructure weather), rather than running and failing.
   *  Its `cycles` is unknowable, so averages that would be skewed by a fake 0 skip
   *  it — the time and tokens it burned are real and still counted. */
  errored?: boolean;
  /** Completion tokens per edit that SURVIVED (`tokensOut` / net-accepted) — the
   *  cost of one durable change rather than one attempt. Omitted when nothing was
   *  accepted, since the ratio is undefined rather than zero. */
  costPerAcceptedChange?: number;
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
  /** Mean completion tokens per run, over runs that recorded any (0 if none).
   *  Read next to `passRate`: a variant is only better if it is not much dearer. */
  avgTokensOut: number;
  /** Mean prompt tokens per run, over runs that recorded any (0 if none). */
  avgTokensIn: number;
  /** Mean cost per surviving edit, over runs that recorded one (0 if none). */
  avgCostPerAcceptedChange: number;
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
