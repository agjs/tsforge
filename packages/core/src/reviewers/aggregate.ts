import { parseReview, parseFinding } from "./schema";
import { isRecord } from "../lib/guards";
import type { IReview, IFinding, FindingCode } from "./schema";

export type ReviewOutcome =
  | { status: "ok"; review: IReview }
  | { status: "errored"; reviewerId: string; error: string };

export interface IRankedFinding extends IFinding {
  agreement: number;
}

export interface IVerdict {
  blocked: boolean;
  reason: string;
  reviewers: { ok: number; errored: number };
  ranked: IRankedFinding[];
  perReviewer: IReview[];
  identity: string;
}

const SECURITY_CODES: readonly FindingCode[] = ["security", "supply-chain"];
const SEVERITY_RANK: Record<IFinding["severity"], number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

function normFile(file: string | undefined): string {
  if (file === undefined) {
    return "<no-file>";
  }

  return file
    .replace(/\\/gu, "/")
    .replace(/^[ab]\//u, "")
    .toLowerCase();
}

function normIssue(issue: string): string {
  return issue
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^(?:the|a|an) /u, "")
    .trim()
    .slice(0, 120);
}

function locusKey(f: IFinding): string {
  const file = normFile(f.file);

  return f.findingCode === "other"
    ? `${file}::${normIssue(f.issue)}`
    : `${file}::${f.findingCode}`;
}

interface IGroup {
  finding: IFinding;
  reviewers: Set<string>;
}

function groupFindings(reviews: IReview[]): Map<string, IGroup> {
  const groups = new Map<string, IGroup>();

  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = locusKey(finding);
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, { finding, reviewers: new Set([review.reviewerId]) });
      } else {
        existing.reviewers.add(review.reviewerId);

        if (
          SEVERITY_RANK[finding.severity] >
          SEVERITY_RANK[existing.finding.severity]
        ) {
          existing.finding = finding;
        }
      }
    }
  }

  return groups;
}

function rank(groups: Map<string, IGroup>): IRankedFinding[] {
  const ranked: IRankedFinding[] = [];

  for (const g of groups.values()) {
    ranked.push({ ...g.finding, agreement: g.reviewers.size });
  }

  return ranked.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] * b.agreement -
      SEVERITY_RANK[a.severity] * a.agreement
  );
}

function isSerious(f: IFinding): boolean {
  return f.severity === "critical" || f.severity === "major";
}

function decideReason(
  reviews: IReview[],
  ranked: IRankedFinding[],
  okCount: number,
  minReviewers: number
): string {
  if (okCount < minReviewers) {
    return `insufficient reviewers (${String(okCount)} of ${String(minReviewers)} required)`;
  }

  if (reviews.some((r) => r.verdict === "reject")) {
    return "a reviewer rejected the change";
  }

  const criticalSecurity = ranked.find(
    (f) => f.severity === "critical" && SECURITY_CODES.includes(f.findingCode)
  );

  if (criticalSecurity !== undefined) {
    return `critical security finding: ${criticalSecurity.issue}`;
  }

  const agreedSerious = ranked.find((f) => f.agreement >= 2 && isSerious(f));

  if (agreedSerious !== undefined) {
    return `${String(agreedSerious.agreement)} reviewers agree on a serious finding: ${agreedSerious.issue}`;
  }

  const wantsChange = reviews.filter((r) => r.verdict !== "approve").length;
  const hasMajor = reviews.some((r) => r.findings.some(isSerious));

  if (wantsChange * 2 > reviews.length && hasMajor) {
    return "majority requested changes with a major finding";
  }

  return "";
}

export function aggregate(
  outcomes: ReviewOutcome[],
  opts: { minReviewers: number; identity: string }
): IVerdict {
  const reviews: IReview[] = [];
  let errored = 0;

  for (const o of outcomes) {
    if (o.status === "ok") {
      reviews.push(o.review);
    } else {
      errored += 1;
    }
  }

  const ranked = rank(groupFindings(reviews));
  const reason = decideReason(
    reviews,
    ranked,
    reviews.length,
    opts.minReviewers
  );

  return {
    blocked: reason.length > 0,
    reason: reason.length > 0 ? reason : "all reviewers approved",
    reviewers: { ok: reviews.length, errored },
    ranked,
    perReviewer: reviews,
    identity: opts.identity,
  };
}

/** Parse and validate a cached verdict artifact. Returns null if any field is
 *  malformed, enabling a corrupt cache entry to be treated as a cache miss. */
export function parseVerdict(raw: unknown): IVerdict | null {
  if (!isRecord(raw)) {
    return null;
  }

  const { blocked, reason, reviewers, ranked, perReviewer, identity } = raw;

  // Validate scalar fields
  if (
    typeof blocked !== "boolean" ||
    typeof reason !== "string" ||
    typeof identity !== "string"
  ) {
    return null;
  }

  // Validate reviewers object
  if (
    !isRecord(reviewers) ||
    typeof reviewers.ok !== "number" ||
    typeof reviewers.errored !== "number"
  ) {
    return null;
  }

  // Validate ranked array
  if (!Array.isArray(ranked)) {
    return null;
  }

  const parsedRanked: IRankedFinding[] = [];

  for (const item of ranked) {
    const finding = parseFinding(item);

    if (
      finding === null ||
      !isRecord(item) ||
      typeof item.agreement !== "number"
    ) {
      return null;
    }

    parsedRanked.push({ ...finding, agreement: item.agreement });
  }

  // Validate perReviewer array
  if (!Array.isArray(perReviewer)) {
    return null;
  }

  const parsedReviews: IReview[] = [];

  for (const item of perReviewer) {
    if (!isRecord(item) || typeof item.reviewerId !== "string") {
      return null;
    }

    const review = parseReview(item.reviewerId, item);

    if (review === null) {
      return null;
    }

    parsedReviews.push(review);
  }

  return {
    blocked,
    reason,
    reviewers: { ok: reviewers.ok, errored: reviewers.errored },
    ranked: parsedRanked,
    perReviewer: parsedReviews,
    identity,
  };
}
