import { test, expect, describe } from "bun:test";
import { formatVerdict } from "../src/cli/harness-review-mode";
import type { IVerdict } from "../src/reviewers/aggregate";

const blocked: IVerdict = {
  blocked: true,
  reason: "a reviewer rejected the change",
  reviewers: { ok: 2, errored: 1 },
  ranked: [
    {
      severity: "major",
      findingCode: "as-cast",
      file: "a.ts",
      issue: "cast",
      agreement: 2,
    },
  ],
  perReviewer: [],
  identity: "local/flash",
};

describe("formatVerdict", () => {
  test("shows BLOCK, the reason, reviewer counts, and ranked findings", () => {
    const out = formatVerdict(blocked);

    expect(out).toMatch(/BLOCK/u);
    expect(out).toContain("a reviewer rejected the change");
    expect(out).toContain("ok: 2");
    expect(out).toContain("errored: 1");
    expect(out).toContain("as-cast");
  });

  test("a passing verdict shows PASS", () => {
    const out = formatVerdict({
      ...blocked,
      blocked: false,
      reason: "all reviewers approved",
      ranked: [],
    });

    expect(out).toMatch(/PASS/u);
  });
});
