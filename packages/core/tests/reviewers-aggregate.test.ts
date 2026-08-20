import { test, expect, describe } from "bun:test";
import {
  aggregate,
  parseVerdict,
  type ReviewOutcome,
  type IVerdict,
} from "../src/reviewers/aggregate";
import type { IReview, IFinding } from "../src/reviewers/schema";
import {
  shouldCacheVerdict,
  honorCachedVerdict,
} from "../src/reviewers/harness-review";

function ok(
  id: string,
  verdict: IReview["verdict"],
  findings: IFinding[] = []
): ReviewOutcome {
  return {
    status: "ok",
    review: { reviewerId: id, verdict, findings, summary: "" },
    ms: 0,
  };
}

const opts = { minReviewers: 2, identity: "local/flash" };

describe("aggregate", () => {
  test("all approve → pass", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "approve")], opts);

    expect(v.blocked).toBe(false);
    expect(v.reviewers).toEqual({ ok: 2, errored: 0 });
  });

  test("a REAL aggregated verdict never carries preReview (so the panel result IS cached)", () => {
    // preReview marks ONLY pre-review gate blocks. If aggregate ever set it, every
    // panel result would be skipped by shouldCacheVerdict and never cached — assert
    // the invariant on both a pass and a reject.
    expect(
      aggregate([ok("a", "approve"), ok("b", "approve")], opts).preReview
    ).toBeUndefined();
    expect(
      aggregate([ok("a", "approve"), ok("b", "reject")], opts).preReview
    ).toBeUndefined();
  });

  test("a short panel is FLAGGED noQuorum, so its block is never cached", () => {
    // The production wiring. shouldCacheVerdict and honorCachedVerdict both test
    // this flag; if aggregate never set it, both guards would be dead code and
    // an outage would keep poisoning the cache exactly as before.
    const allErrored = aggregate(
      [
        {
          status: "errored",
          reviewerId: "a",
          error: "connection refused",
          cause: "threw",
          ms: 0,
        },
        {
          status: "errored",
          reviewerId: "b",
          error: "connection refused",
          cause: "threw",
          ms: 0,
        },
      ],
      opts
    );

    expect(allErrored.reviewers).toEqual({ ok: 0, errored: 2 });
    expect(allErrored.noQuorum).toBe(true);
    expect(shouldCacheVerdict(allErrored)).toBe(false);

    // One short of quorum is the same category: not enough opinions to be a
    // judgment about the code.
    const oneShort = aggregate(
      [
        ok("a", "approve"),
        {
          status: "errored",
          reviewerId: "b",
          error: "timeout",
          cause: "threw",
          ms: 0,
        },
      ],
      opts
    );

    expect(oneShort.noQuorum).toBe(true);
    expect(shouldCacheVerdict(oneShort)).toBe(false);
  });

  test("a panel that REACHED quorum is cached, block or pass", () => {
    // The other half of the invariant: this must not turn into "never cache a
    // block". A real reject is a judgment about the code and caching it is the
    // whole point of the cache.
    const reject = aggregate([ok("a", "approve"), ok("b", "reject")], opts);

    expect(reject.blocked).toBe(true);
    expect(reject.noQuorum).toBeUndefined();
    expect(shouldCacheVerdict(reject)).toBe(true);

    const pass = aggregate([ok("a", "approve"), ok("b", "approve")], opts);

    expect(pass.noQuorum).toBeUndefined();
    expect(shouldCacheVerdict(pass)).toBe(true);
  });

  test("insufficient reviewers → block", () => {
    const v = aggregate(
      [
        ok("a", "approve"),
        {
          status: "errored",
          reviewerId: "b",
          error: "timeout",
          cause: "threw",
          ms: 0,
        },
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/insufficient reviewers/u);
    expect(v.reviewers).toEqual({ ok: 1, errored: 1 });
  });

  test("any reject → block", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "reject")], opts);

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/rejected/u);
  });

  test("single critical security finding → block", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [
          {
            severity: "critical",
            findingCode: "security",
            file: "s.ts",
            issue: "ssrf",
          },
        ]),
        ok("b", "approve"),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/critical security/u);
  });

  test("two reviewers agree on a major at same locus → block", () => {
    const f: IFinding = {
      severity: "major",
      findingCode: "as-cast",
      file: "a.ts",
      issue: "cast here",
    };
    const v = aggregate(
      [ok("a", "request-changes", [f]), ok("b", "request-changes", [{ ...f }])],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
    expect(v.reason).toMatch(/agree/u);
  });

  test("a below-threshold dissent passes but the reason does NOT claim everyone approved", () => {
    // One reviewer requests changes with a CRITICAL (non-security) finding, the
    // other approves. Corroboration policy is unchanged — a single uncorroborated
    // non-security finding does not block — but the verdict used to report
    // "all reviewers approved", a false statement that misinforms anyone reading
    // it (and any steer built from the reason). blocked stays false; reason must
    // reflect the dissent.
    const v = aggregate(
      [
        ok("a", "request-changes", [
          {
            severity: "critical",
            findingCode: "complexity",
            file: "a.ts",
            issue: "unbounded recursion, stack overflow on large N",
          },
        ]),
        ok("b", "approve"),
      ],
      opts
    );

    expect(v.blocked).toBe(false);
    expect(v.reason).not.toBe("all reviewers approved");
    expect(v.reason).toMatch(/requested changes/u);
  });

  test("a genuinely unanimous approval still reads 'all reviewers approved'", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "approve")], opts);

    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("all reviewers approved");
  });

  test("majority request-changes with a major but no locus agreement → block", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [
          {
            severity: "major",
            findingCode: "missing-test",
            file: "a.ts",
            issue: "no test",
          },
        ]),
        ok("b", "request-changes", [
          {
            severity: "major",
            findingCode: "dead-code",
            file: "b.ts",
            issue: "unused",
          },
        ]),
        ok("c", "approve"),
      ],
      { minReviewers: 2, identity: "x" }
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/majority/u);
  });

  test("locus keys on findingCode, not exact line (different lines still agree)", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [
          {
            severity: "major",
            findingCode: "as-cast",
            file: "a.ts",
            line: 10,
            issue: "x",
          },
        ]),
        ok("b", "request-changes", [
          {
            severity: "major",
            findingCode: "as-cast",
            file: "a.ts",
            line: 99,
            issue: "y",
          },
        ]),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
  });

  test("one minor finding, both approve → pass", () => {
    const v = aggregate(
      [
        ok("a", "approve", [
          {
            severity: "minor",
            findingCode: "other",
            file: "a.ts",
            issue: "nit",
          },
        ]),
        ok("b", "approve"),
      ],
      opts
    );

    expect(v.blocked).toBe(false);
  });
});

describe("parseVerdict", () => {
  test("valid verdict round-trips", () => {
    const v: IVerdict = {
      blocked: true,
      reason: "critical security finding: ssrf",
      reviewers: { ok: 2, errored: 0 },
      ranked: [
        {
          severity: "critical",
          findingCode: "security",
          file: "a.ts",
          line: 42,
          issue: "ssrf vulnerability",
          agreement: 2,
        },
      ],
      perReviewer: [
        {
          reviewerId: "a",
          verdict: "request-changes",
          findings: [
            {
              severity: "critical",
              findingCode: "security",
              file: "a.ts",
              line: 42,
              issue: "ssrf vulnerability",
            },
          ],
          summary: "found security issue",
        },
        {
          reviewerId: "b",
          verdict: "approve",
          findings: [],
          summary: "looks good",
        },
      ],
      identity: "local/flash",
    };

    const parsed = parseVerdict(v);

    expect(parsed).not.toBeNull();
    expect(parsed?.blocked).toBe(true);
    expect(parsed?.reason).toBe("critical security finding: ssrf");
    expect(parsed?.identity).toBe("local/flash");
    expect(parsed?.reviewers).toEqual({ ok: 2, errored: 0 });
    expect(parsed?.ranked).toHaveLength(1);
    expect(parsed?.ranked[0]?.agreement).toBe(2);
    expect(parsed?.perReviewer).toHaveLength(2);
  });

  test("round-trips the noQuorum flag through the REAL read path", () => {
    // The production read is readCachedVerdict -> parseVerdict ->
    // honorCachedVerdict. The honorCachedVerdict unit test hands it an object
    // directly and so bypasses parseVerdict entirely: if a refactor dropped the
    // flag on read, that test stays green while the cache-poison bug quietly
    // returns. This is the only assertion that covers the seam.
    const raw: unknown = JSON.parse(
      JSON.stringify({
        blocked: true,
        reason: "insufficient reviewers (0 of 2 required)",
        reviewers: { ok: 0, errored: 4 },
        ranked: [],
        perReviewer: [],
        identity: "local/flash",
        noQuorum: true,
      })
    );
    const parsed = parseVerdict(raw);

    expect(parsed?.noQuorum).toBe(true);
    expect(honorCachedVerdict(parsed)).toBeNull();
  });

  test("a verdict without noQuorum parses to undefined (not injected)", () => {
    // The mirror: injecting the flag where it was absent would make every
    // cached verdict unusable and silently disable the cache.
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 4, errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: "local/flash",
    };
    const parsed = parseVerdict(v);

    expect(parsed?.noQuorum).toBeUndefined();
    expect(honorCachedVerdict(parsed)).toBe(parsed);
  });

  test("round-trips the preReview flag (cache-poison guard survives serialize→parse)", () => {
    const v = {
      blocked: true,
      reason: "validate failed",
      reviewers: { ok: 0, errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: "local/flash",
      preReview: true,
    };

    // The flag MUST survive a read so the read-side guard can reject a legacy
    // poisoned block; dropping it here would silently re-enable the poison.
    expect(parseVerdict(v)?.preReview).toBe(true);
  });

  test("a verdict without preReview parses to preReview undefined (not injected)", () => {
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 2, errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: "local/flash",
    };

    expect(parseVerdict(v)?.preReview).toBeUndefined();
  });

  test("missing verdict key → null", () => {
    const raw = { some: "object" };

    expect(parseVerdict(raw)).toBeNull();
  });

  test("non-object input → null", () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict("string")).toBeNull();
    expect(parseVerdict(123)).toBeNull();
  });

  test("malformed reviewers object → null", () => {
    const v = {
      blocked: true,
      reason: "test",
      reviewers: { ok: "two", errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: "x",
    };

    expect(parseVerdict(v)).toBeNull();
  });

  test("missing identity string → null", () => {
    const v = {
      blocked: true,
      reason: "test",
      reviewers: { ok: 2, errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: 123,
    };

    expect(parseVerdict(v)).toBeNull();
  });

  test("malformed ranked finding → null", () => {
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 2, errored: 0 },
      ranked: [
        {
          severity: "critical",
          findingCode: "as-cast",
          issue: "cast here",
          agreement: "two",
        },
      ],
      perReviewer: [],
      identity: "x",
    };

    expect(parseVerdict(v)).toBeNull();
  });

  test("malformed reviewer in perReviewer → null", () => {
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 1, errored: 0 },
      ranked: [],
      perReviewer: [
        {
          reviewerId: "a",
          verdict: "invalid-verdict",
          findings: [],
          summary: "test",
        },
      ],
      identity: "x",
    };

    expect(parseVerdict(v)).toBeNull();
  });

  test("non-array ranked → null", () => {
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 1, errored: 0 },
      ranked: "not an array",
      perReviewer: [],
      identity: "x",
    };

    expect(parseVerdict(v)).toBeNull();
  });

  test("non-array perReviewer → null", () => {
    const v = {
      blocked: false,
      reason: "",
      reviewers: { ok: 1, errored: 0 },
      ranked: [],
      perReviewer: { not: "array" },
      identity: "x",
    };

    expect(parseVerdict(v)).toBeNull();
  });
});
