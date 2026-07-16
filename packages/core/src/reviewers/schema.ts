import { isRecord } from "../lib/guards";

export type Severity = "critical" | "major" | "minor";

export const FINDING_CODES = [
  "missing-test",
  "as-cast",
  "non-null-assert",
  "gate-relaxed",
  "complexity",
  "scope-bypass",
  "security",
  "supply-chain",
  "dead-code",
  "wrong-idiom",
  "other",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export type ReviewVerdict = "approve" | "request-changes" | "reject";

export interface IFinding {
  severity: Severity;
  findingCode: FindingCode;
  file?: string;
  line?: number;
  issue: string;
  fix?: string;
}

export interface IReview {
  reviewerId: string;
  verdict: ReviewVerdict;
  findings: IFinding[];
  summary: string;
}

export interface IValidateSummary {
  passed: boolean;
  failCount: number;
  firstErrors: string[];
}

/** FROZEN — Phase 2 reuses this unchanged. */
export interface IReviewRequest {
  title: string;
  intent: string;
  diff: string;
  validateSummary: IValidateSummary;
  contextFiles?: string[];
  rubricVersion: string;
}

export const RUBRIC_VERSION = "1";

export const REVIEW_RUBRIC = [
  "House rules the change MUST satisfy:",
  "- No `as` casts (except `as const`); no non-null `!`; no `any`.",
  "- Cognitive complexity <= 20 per function; extract helpers instead of raising it.",
  "- Every changed code file has a mirrored test; new behavior is tested.",
  "- The gate is never relaxed (no downgraded severities/thresholds, no disabled rules).",
  "- Tools/reviewers stay independent; no self-review shortcuts.",
  "- No silent truncation, no dead code, no scope bypass.",
].join("\n");

export const REVIEW_SYSTEM_PROMPT = [
  "You are an independent, skeptical code reviewer. Default to reject when unsure.",
  "You are reviewing a change to a build harness. Find real defects, not style nits.",
  "Respond with ONE JSON object and nothing else:",
  '{ "verdict": "approve"|"request-changes"|"reject",',
  '  "summary": string,',
  '  "findings": [ { "severity": "critical"|"major"|"minor",',
  `    "findingCode": one of ${FINDING_CODES.join("|")},`,
  '    "file"?: string, "line"?: number, "issue": string, "fix"?: string } ] }',
  "",
  REVIEW_RUBRIC,
].join("\n");

function isSeverity(v: unknown): v is Severity {
  return v === "critical" || v === "major" || v === "minor";
}

function isFindingCode(v: unknown): v is FindingCode {
  return (
    typeof v === "string" &&
    (v === "missing-test" ||
      v === "as-cast" ||
      v === "non-null-assert" ||
      v === "gate-relaxed" ||
      v === "complexity" ||
      v === "scope-bypass" ||
      v === "security" ||
      v === "supply-chain" ||
      v === "dead-code" ||
      v === "wrong-idiom" ||
      v === "other")
  );
}

function isVerdict(v: unknown): v is ReviewVerdict {
  return v === "approve" || v === "request-changes" || v === "reject";
}

export function parseFinding(raw: unknown): IFinding | null {
  if (
    !isRecord(raw) ||
    !isSeverity(raw.severity) ||
    !isFindingCode(raw.findingCode)
  ) {
    return null;
  }

  if (typeof raw.issue !== "string") {
    return null;
  }

  const finding: IFinding = {
    severity: raw.severity,
    findingCode: raw.findingCode,
    issue: raw.issue,
  };

  if (typeof raw.file === "string") {
    finding.file = raw.file;
  }

  if (typeof raw.line === "number") {
    finding.line = raw.line;
  }

  if (typeof raw.fix === "string") {
    finding.fix = raw.fix;
  }

  return finding;
}

/** Validate a model/binary's raw JSON into an IReview. Returns null on ANY
 *  malformation — the caller records that reviewer as `errored`, never as an
 *  approval, so a parse failure can't sneak through as a pass. */
export function parseReview(reviewerId: string, raw: unknown): IReview | null {
  if (
    !isRecord(raw) ||
    !isVerdict(raw.verdict) ||
    typeof raw.summary !== "string"
  ) {
    return null;
  }

  if (!Array.isArray(raw.findings)) {
    return null;
  }

  const findings: IFinding[] = [];

  for (const f of raw.findings) {
    const parsed = parseFinding(f);

    if (parsed === null) {
      return null;
    }

    findings.push(parsed);
  }

  return { reviewerId, verdict: raw.verdict, findings, summary: raw.summary };
}

export function renderReviewPrompt(req: IReviewRequest): string {
  const validate = req.validateSummary.passed
    ? "validate: PASSED"
    : `validate: FAILED (${String(req.validateSummary.failCount)} errors)\n${req.validateSummary.firstErrors.join("\n")}`;

  const context =
    req.contextFiles !== undefined && req.contextFiles.length > 0
      ? [
          "",
          "## Current file contents (review the diff AGAINST this real code, not in isolation)",
          ...req.contextFiles,
        ]
      : [];

  return [
    `# Change under review: ${req.title}`,
    `Rubric version: ${req.rubricVersion}`,
    "",
    "## Intent",
    req.intent,
    "",
    `## ${validate}`,
    "",
    "## Diff",
    req.diff,
    ...context,
  ].join("\n");
}
