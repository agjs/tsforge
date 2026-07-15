import { test, expect, describe } from "bun:test";
import { aggregate, type ReviewOutcome } from "../src/reviewers/aggregate";
import type { IReview, IFinding } from "../src/reviewers/schema";

function ok(id: string, verdict: IReview["verdict"], findings: IFinding[] = []): ReviewOutcome {
  return { status: "ok", review: { reviewerId: id, verdict, findings, summary: "" } };
}

const opts = { minReviewers: 2, identity: "local/flash" };

describe("aggregate", () => {
  test("all approve → pass", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "approve")], opts);

    expect(v.blocked).toBe(false);
    expect(v.reviewers).toEqual({ ok: 2, errored: 0 });
  });

  test("insufficient reviewers → block", () => {
    const v = aggregate([ok("a", "approve"), { status: "errored", reviewerId: "b", error: "timeout" }], opts);

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
        ok("a", "request-changes", [{ severity: "critical", findingCode: "security", file: "s.ts", issue: "ssrf" }]),
        ok("b", "approve"),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/critical security/u);
  });

  test("two reviewers agree on a major at same locus → block", () => {
    const f: IFinding = { severity: "major", findingCode: "as-cast", file: "a.ts", issue: "cast here" };
    const v = aggregate([ok("a", "request-changes", [f]), ok("b", "request-changes", [{ ...f }])], opts);

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
    expect(v.reason).toMatch(/agree/u);
  });

  test("majority request-changes with a major but no locus agreement → block", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [{ severity: "major", findingCode: "missing-test", file: "a.ts", issue: "no test" }]),
        ok("b", "request-changes", [{ severity: "major", findingCode: "dead-code", file: "b.ts", issue: "unused" }]),
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
        ok("a", "request-changes", [{ severity: "major", findingCode: "as-cast", file: "a.ts", line: 10, issue: "x" }]),
        ok("b", "request-changes", [{ severity: "major", findingCode: "as-cast", file: "a.ts", line: 99, issue: "y" }]),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
  });

  test("one minor finding, both approve → pass", () => {
    const v = aggregate(
      [ok("a", "approve", [{ severity: "minor", findingCode: "other", file: "a.ts", issue: "nit" }]), ok("b", "approve")],
      opts
    );

    expect(v.blocked).toBe(false);
  });
});
