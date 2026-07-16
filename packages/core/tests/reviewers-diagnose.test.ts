import { test, expect, describe } from "bun:test";
import {
  aggregateDiagnoses,
  type DiagOutcome,
} from "../src/reviewers/diagnose";
import type { IDiagnosis } from "../src/reviewers/diagnose-schema";

function ok(
  reviewerId: string,
  category: IDiagnosis["category"],
  suggestedFix = "fix"
): DiagOutcome {
  return {
    status: "ok",
    diagnosis: {
      reviewerId,
      category,
      confidence: "high",
      rootCause: "because",
      suggestedFix,
    },
  };
}

function err(reviewerId: string): DiagOutcome {
  return { status: "errored", reviewerId, error: "boom" };
}

describe("aggregateDiagnoses", () => {
  test("majority category wins; agreement counts the agreeing reviewers", () => {
    const c = aggregateDiagnoses([
      ok("a", "gate-parity"),
      ok("b", "gate-parity"),
      ok("c", "near-green-oscillation"),
    ]);

    expect(c.category).toBe("gate-parity");
    expect(c.agreement).toBe(2);
    expect(c.totalOk).toBe(3);
  });

  test("errored reviewers are counted but never vote", () => {
    const c = aggregateDiagnoses([ok("a", "wrong-idiom"), err("b"), err("c")]);

    expect(c.category).toBe("wrong-idiom");
    expect(c.totalOk).toBe(1);
    expect(c.totalErrored).toBe(2);
    expect(c.agreement).toBe(1);
  });

  test("no successful reviewer → null consensus, no crash", () => {
    const c = aggregateDiagnoses([err("a"), err("b")]);

    expect(c.category).toBeNull();
    expect(c.totalOk).toBe(0);
    expect(c.suggestedFixes).toEqual([]);
  });

  test("a tie resolves to the earlier (more structural) category", () => {
    // gate-parity precedes near-green-oscillation in FAILURE_CATEGORIES.
    const c = aggregateDiagnoses([
      ok("a", "near-green-oscillation"),
      ok("b", "gate-parity"),
    ]);

    expect(c.category).toBe("gate-parity");
    expect(c.agreement).toBe(1);
  });

  test("suggestedFixes are the distinct fixes from the consensus voters only", () => {
    const c = aggregateDiagnoses([
      ok("a", "gate-parity", "make gates identical"),
      ok("b", "gate-parity", "make gates identical"),
      ok("c", "gate-parity", "run prettier at write time"),
      ok("d", "scaffold-infra", "irrelevant fix"),
    ]);

    expect(c.category).toBe("gate-parity");
    expect(c.suggestedFixes).toHaveLength(2);
    expect(c.suggestedFixes).toContain("make gates identical");
    expect(c.suggestedFixes).toContain("run prettier at write time");
    expect(c.suggestedFixes).not.toContain("irrelevant fix");
  });
});
