import { test, expect } from "bun:test";
import { formatReviewCard } from "../src/loop/review/format-card";
import type { IReviewReport } from "../src/loop/review/review.types";
import { stripSgr } from "../src/render";
import { displayWidth } from "../src/render/width";

const FINDING = {
  file: "src/collision.ts",
  line: 25,
  severity: "error" as const,
  lens: "data-concurrency",
  claim:
    "returns a shared module-level scratch vector so concurrent callers corrupt data",
  reason:
    "SCRATCH is a module-level singleton; a second call before the first result is consumed overwrites it, so the earlier caller reads the wrong normal — a real data race in the render loop",
  suggestedFix: "return this.scratch.clone();",
  verified: true,
  verdict: "confirmed",
};

function report(over: Partial<IReviewReport> = {}): IReviewReport {
  return {
    base: "HEAD",
    changedFiles: ["src/collision.ts"],
    findings: [FINDING],
    rejected: 12,
    ...over,
  };
}

/** No RENDERED line may exceed the target width (SGR stripped, display-width). */
function assertWithin(text: string, width: number): void {
  for (const line of text.split("\n")) {
    expect(displayWidth(stripSgr(line))).toBeLessThanOrEqual(width);
  }
}

test("wraps every line to the target width (nothing overflows the pane)", () => {
  const width = 40;

  assertWithin(formatReviewCard(report(), width, true), width);
});

test("renders the badge, file:line, claim, reason, and suggested fix", () => {
  const plain = stripSgr(formatReviewCard(report(), 100, true));

  expect(plain).toContain("ERROR");
  expect(plain).toContain("src/collision.ts:25");
  expect(plain).toContain("[data-concurrency]");
  expect(plain).toContain("scratch vector");
  expect(plain).toContain("data race");
  expect(plain).toContain("fix:");
  expect(plain).toContain("return this.scratch.clone();");
});

test("color:false emits no SGR; color:true does", () => {
  const plainCard = formatReviewCard(report(), 80, false);
  const colorCard = formatReviewCard(report(), 80, true);

  // Nothing to strip when color is off.
  expect(stripSgr(plainCard)).toBe(plainCard);
  expect(plainCard).toContain("ERROR");
  // Color on ⇒ stripping changes the string (SGR present).
  expect(stripSgr(colorCard)).not.toBe(colorCard);
});

test("zero findings renders a clean-review header, not a wall of nothing", () => {
  const card = stripSgr(formatReviewCard(report({ findings: [] }), 80, true));

  expect(card).toContain("no issues");
  expect(card).toContain("12 candidate(s) rejected");
});

test("no changed files → a single quiet line", () => {
  const card = stripSgr(
    formatReviewCard(report({ changedFiles: [], findings: [] }), 80, true)
  );

  expect(card).toContain("No changed files");
});

test("gate-aware note renders when rules were skipped", () => {
  const card = stripSgr(
    formatReviewCard(
      report({ findings: [], gateFailingRules: ["TS2322", "no-as-cast"] }),
      100,
      true
    )
  );

  expect(card).toContain("gate-aware: skipped 2");
});

test("severity ordering: errors before warnings before info", () => {
  const many = report({
    findings: [
      { ...FINDING, severity: "info", claim: "an info note", reason: "x" },
      { ...FINDING, severity: "error", claim: "an error", reason: "y" },
      { ...FINDING, severity: "warning", claim: "a warning", reason: "z" },
    ],
  });
  const plain = stripSgr(formatReviewCard(many, 100, true));

  expect(plain.indexOf("an error")).toBeLessThan(plain.indexOf("a warning"));
  expect(plain.indexOf("a warning")).toBeLessThan(
    plain.indexOf("an info note")
  );
});

test("a finding without a suggestedFix omits the fix line", () => {
  const { suggestedFix: _omit, ...noFix } = FINDING;
  const plain = stripSgr(
    formatReviewCard(report({ findings: [noFix] }), 100, true)
  );

  expect(plain).not.toContain("fix:");
});
