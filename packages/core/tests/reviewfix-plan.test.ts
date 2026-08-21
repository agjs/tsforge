import { test, expect } from "bun:test";
import { reviewFindingsToDrafts } from "../src/cli/repl";
import type { IReviewReport } from "../src/loop";

function report(over: Partial<IReviewReport> = {}): IReviewReport {
  return {
    base: "HEAD",
    changedFiles: ["a.ts"],
    findings: [],
    rejected: 0,
    ...over,
  };
}

const finding = (
  over: Partial<IReviewReport["findings"][number]> = {}
): IReviewReport["findings"][number] => ({
  file: "a.ts",
  line: 10,
  severity: "warning",
  lens: "review",
  claim: "a claim",
  reason: "the reason",
  verified: true,
  verdict: "reviewed",
  ...over,
});

test("one draft per finding: title=claim, files=[file], kind=modify", () => {
  const drafts = reviewFindingsToDrafts(
    report({
      findings: [finding({ file: "src/x.ts", line: 3, claim: "off-by-one" })],
    })
  );

  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({
    title: "off-by-one",
    files: ["src/x.ts"],
    kind: "modify",
  });
  // detail carries the grounding: file:line, lens, severity, and the reason.
  expect(drafts[0]?.detail).toContain("src/x.ts:3");
  expect(drafts[0]?.detail).toContain("the reason");
});

test("orders worst-severity first (error → warning → info)", () => {
  const drafts = reviewFindingsToDrafts(
    report({
      findings: [
        finding({ severity: "info", claim: "info one" }),
        finding({ severity: "error", claim: "error one" }),
        finding({ severity: "warning", claim: "warn one" }),
      ],
    })
  );

  expect(drafts.map((d) => d.title)).toEqual([
    "error one",
    "warn one",
    "info one",
  ]);
});

test("includes the suggested fix in detail only when present", () => {
  const [withFix, withoutFix] = reviewFindingsToDrafts(
    report({
      findings: [
        finding({ severity: "error", suggestedFix: "return a - b;" }),
        finding({ severity: "warning" }),
      ],
    })
  );

  expect(withFix?.detail).toContain("Suggested fix: return a - b;");
  expect(withoutFix?.detail).not.toContain("Suggested fix:");
});
