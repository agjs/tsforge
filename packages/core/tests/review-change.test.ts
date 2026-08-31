import { test, expect } from "bun:test";
import { renderReport, formatReport } from "../src/loop/review/review-change";
import type { IReviewReport } from "../src/loop/review/review.types";

const BASE_REPORT: IReviewReport = {
  base: "main",
  changedFiles: ["src/a.ts"],
  findings: [
    {
      file: "src/a.ts",
      line: 10,
      severity: "error",
      lens: "logic",
      claim: "off-by-one",
      reason: "loop reads one past the array end",
      verified: true,
      verdict: "confirmed",
    },
  ],
  rejected: 0,
};

test("renderReport(json=true) emits the report as a single JSON line, not the text format", () => {
  const out = renderReport(BASE_REPORT, true);

  expect(out).not.toContain("\n");
  expect(JSON.parse(out)).toEqual(BASE_REPORT);
});

test("renderReport(json=false) falls through to formatReport, unchanged", () => {
  expect(renderReport(BASE_REPORT, false)).toBe(formatReport(BASE_REPORT));
});

test("renderReport(json=true) round-trips an empty-findings report too", () => {
  const empty: IReviewReport = { ...BASE_REPORT, findings: [] };
  const out = renderReport(empty, true);

  expect(JSON.parse(out)).toEqual(empty);
});
