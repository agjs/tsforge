import { parseReview, parseFinding } from "./schema";
import { isRecord } from "../lib/guards";
import type { IReview, IFinding, FindingCode } from "./schema";

export type ReviewOutcome =
  | { status: "ok"; review: IReview; ms: number }
  | {
      status: "errored";
      reviewerId: string;
      error: string;
      /** Wall-clock ms the reviewer consumed before failing. Without it a crash
       *  and a timeout are indistinguishable in the logs, which is exactly the
       *  question you want answered when a panel comes back short: did this
       *  reviewer die instantly, or did it burn its whole budget doing work that
       *  was then thrown away? Diagnosing that once took an afternoon of timing
       *  the binaries by hand. */
      ms: number;
      /** Why it failed, as a category rather than prose: `timeout` (killed at
       *  the budget), `exit` (ran, exited non-zero), `unparseable` (answered,
       *  but not in the review schema), `threw` (the call itself failed). The
       *  old string said "binary exited non-zero or timed out" for the first two
       *  at once and so could not tell them apart. */
      cause: ReviewFailureCause;
    };

/** The failure taxonomy, and the single source of the union below. `timeout`
 *  means the budget was too small for the work (raise it, or drop the reviewer);
 *  `exit` means the binary is broken (the budget is irrelevant). Collapsing those
 *  two into one message is what made this undiagnosable. */
const FAILURE_CAUSES = [
  "timeout",
  "exit",
  "truncated",
  "unparseable",
  "threw",
] as const;

export type ReviewFailureCause = (typeof FAILURE_CAUSES)[number];

/** Widened to string so `includes` accepts an unknown-origin value. Kept next to
 *  FAILURE_CAUSES, which the union is derived FROM, so the two cannot drift. */
const KNOWN_CAUSES: readonly string[] = FAILURE_CAUSES;

/** Narrow an unknown to a known cause. A type guard, not an `as` cast: the value
 *  comes off disk and an unrecognised string must be dropped, not asserted. */
function isFailureCause(value: unknown): value is ReviewFailureCause {
  return typeof value === "string" && KNOWN_CAUSES.includes(value);
}

export interface IReviewerFailure {
  reviewerId: string;
  error: string;
  cause?: ReviewFailureCause;
  ms?: number;
}

export interface IRankedFinding extends IFinding {
  agreement: number;
}

export interface IVerdict {
  blocked: boolean;
  reason: string;
  reviewers: { ok: number; errored: number };
  /** Who failed and why, one entry per errored reviewer. The counts alone say a
   *  panel came back short; they never say WHICH reviewer, or whether it died
   *  instantly or burned its whole budget — and those imply opposite fixes.
   *  Empty/absent when every reviewer answered. */
  failures?: IReviewerFailure[];
  ranked: IRankedFinding[];
  perReviewer: IReview[];
  identity: string;
  /** True when this verdict is a PRE-REVIEW gate/precondition block (validate
   *  failed, empty intent, diff too large) — the panel never ran. These are
   *  transient/precondition failures, NOT reviewer judgments, so they must never
   *  be cached: a flaky validate under load would otherwise poison the tree-hash
   *  and block every future push until the cache is hand-purged. */
  preReview?: boolean;
  /** True when the panel RAN but too few reviewers came back to reach the
   *  quorum — every one of them errored, or enough did. Same category as
   *  `preReview` and cached under the same rule: an endpoint that was down is
   *  not a judgment about the code. Without this, one outage writes a BLOCK
   *  against the tree hash and re-serves it for that exact tree forever, so the
   *  only ways past it are to touch a file or vary the intent string (which
   *  feeds the cache key). Observed live on 2026-08-05: `ok: 0, errored: 4`
   *  cached, then replayed as `cache hit, reusing verdict`. */
  noQuorum?: boolean;
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
  const failures: IReviewerFailure[] = [];

  for (const o of outcomes) {
    if (o.status === "ok") {
      reviews.push(o.review);
    } else {
      // No optional spreads: the outcome contract requires both, which is the
      // point of requiring them — a runner cannot omit a cause and have it
      // quietly read as an exit.
      failures.push({
        reviewerId: o.reviewerId,
        error: o.error,
        cause: o.cause,
        ms: o.ms,
      });
    }
  }

  const errored = failures.length;

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
    ...(failures.length > 0 ? { failures } : {}),
    ...(reviews.length < opts.minReviewers ? { noQuorum: true } : {}),
  };
}

/**
 * Rehydrate the per-reviewer failure diagnostics from a cached artifact.
 *
 * A malformed entry is DROPPED rather than failing the whole parse: these are
 * informational, and losing one diagnostic line is not a reason to treat an
 * otherwise valid cached verdict as corrupt and re-run the entire panel.
 */
function parseFailures(raw: unknown): IReviewerFailure[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: IReviewerFailure[] = [];

  for (const f of raw) {
    if (
      isRecord(f) &&
      typeof f.reviewerId === "string" &&
      typeof f.error === "string"
    ) {
      out.push({
        reviewerId: f.reviewerId,
        error: f.error,
        ...(isFailureCause(f.cause) ? { cause: f.cause } : {}),
        // Finite, not merely numeric: a NaN or Infinity off disk would be
        // printed as "NaNs" / "Infinitys" in the verdict, which is worse than
        // omitting the duration.
        ...(typeof f.ms === "number" && Number.isFinite(f.ms)
          ? { ms: f.ms }
          : {}),
      });
    }
  }

  return out;
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

  const parsedFailures = parseFailures(raw.failures);

  return {
    blocked,
    reason,
    reviewers: { ok: reviewers.ok, errored: reviewers.errored },
    ranked: parsedRanked,
    perReviewer: parsedReviews,
    identity,
    ...(parsedFailures.length > 0 ? { failures: parsedFailures } : {}),
    ...(raw.preReview === true ? { preReview: true } : {}),
    ...(raw.noQuorum === true ? { noQuorum: true } : {}),
  };
}
