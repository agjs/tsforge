/** Review findings are about FUNCTIONALITY (logic, regressions, edge cases,
 *  business rules) — not types/structure/style, which the gate already covers. */

export type Severity = "error" | "warning" | "info";

/** One reviewing perspective (a senior-engineer "lens"), fed to the model as its
 *  rubric so a small local model reviews systematically instead of skimming. */
export interface ILens {
  /** Stable id used as the finding's `lens` tag. */
  id: string;
  title: string;
  /** What this lens looks for. */
  focus: string;
  /** Concrete "ask yourself" prompts. */
  questions: string[];
  /** A one-line concrete example of a real problem this lens catches. */
  example: string;
}

/** A raw finding from the find pass (before verification). */
export interface IRepoFinding {
  file: string;
  line: number;
  severity: Severity;
  /** The lens id it came from. */
  lens: string;
  /** The problem, stated concretely. */
  claim: string;
  /** Why it's a problem. */
  reason: string;
}

/** A finding after the adversarial-verify pass. */
export interface IVerifiedFinding extends IRepoFinding {
  /** Survived verification (the cited code confirms the problem). */
  verified: boolean;
  /** The verifier's one-line judgement. */
  verdict: string;
}

export interface IReviewReport {
  /** The ref the working tree was diffed against (the auto-detected base). */
  base: string;
  changedFiles: string[];
  /** Verified survivors only (the report shown to the user). */
  findings: IVerifiedFinding[];
  /** How many raw findings the verify pass rejected (precision signal). */
  rejected: number;
  /** Failing gate rules the find pass was told to skip (from a gate-aware run);
   *  empty when review ran without a gate signal. */
  gateFailingRules: string[];
}
