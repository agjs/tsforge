import { test, expect, describe } from "bun:test";
import {
  parseReview,
  renderReviewPrompt,
  RUBRIC_VERSION,
  REVIEW_SYSTEM_PROMPT,
  type IReviewRequest,
} from "../src/reviewers/schema";

describe("parseReview", () => {
  test("accepts a well-formed review", () => {
    const r = parseReview("opus", {
      verdict: "request-changes",
      summary: "one issue",
      findings: [
        { severity: "major", findingCode: "as-cast", file: "a.ts", issue: "cast" },
      ],
    });

    expect(r).not.toBeNull();
    expect(r?.reviewerId).toBe("opus");
    expect(r?.findings[0]?.findingCode).toBe("as-cast");
  });

  test("returns null on an unknown verdict (parse fail, not silent approve)", () => {
    expect(parseReview("opus", { verdict: "lgtm", summary: "", findings: [] })).toBeNull();
  });

  test("returns null on an unknown findingCode", () => {
    const r = parseReview("opus", {
      verdict: "reject",
      summary: "x",
      findings: [{ severity: "critical", findingCode: "vibes", issue: "y" }],
    });

    expect(r).toBeNull();
  });

  test("returns null when findings is not an array", () => {
    expect(parseReview("opus", { verdict: "approve", summary: "", findings: {} })).toBeNull();
  });
});

describe("renderReviewPrompt", () => {
  test("embeds intent, diff, validate summary and the rubric version", () => {
    const req: IReviewRequest = {
      title: "t",
      intent: "add X",
      diff: "diff --git a b",
      validateSummary: { passed: true, failCount: 0, firstErrors: [] },
      rubricVersion: RUBRIC_VERSION,
    };
    const prompt = renderReviewPrompt(req);

    expect(prompt).toContain("add X");
    expect(prompt).toContain("diff --git a b");
    expect(REVIEW_SYSTEM_PROMPT).toContain("reject");
  });
});
