import { test, expect, describe } from "bun:test";
import { summarizeAxeViolations, checkPerfBudget } from "../src/browser";

describe("summarizeAxeViolations", () => {
  test("only serious/critical violations become errors", () => {
    const out = summarizeAxeViolations(
      [
        { id: "color-contrast", impact: "serious", nodeCount: 3 },
        { id: "image-alt", impact: "critical", nodeCount: 1 },
        { id: "landmark", impact: "moderate", nodeCount: 5 },
        { id: "region", impact: "minor", nodeCount: 2 },
        { id: "unknown", impact: undefined, nodeCount: 1 },
      ],
      "/reports"
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toContain("color-contrast");
    expect(out[0]).toContain("serious");
    expect(out[0]).toContain("/reports");
    expect(out[1]).toContain("image-alt");
  });

  test("no serious/critical → no errors", () => {
    expect(
      summarizeAxeViolations(
        [{ id: "x", impact: "moderate", nodeCount: 1 }],
        "index"
      )
    ).toEqual([]);
  });
});

describe("checkPerfBudget", () => {
  test("flags DOM node and mount-time overages, with the location", () => {
    const out = checkPerfBudget(
      8000,
      9000,
      { maxDomNodes: 5000, maxMountMs: 6000 },
      "index"
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toContain("8000 DOM nodes");
    expect(out[0]).toContain("index");
    expect(out[1]).toContain("mount");
  });

  test("within budget → no errors; unset limits are ignored", () => {
    expect(
      checkPerfBudget(100, 100, { maxDomNodes: 5000, maxMountMs: 6000 }, "x")
    ).toEqual([]);
    expect(checkPerfBudget(99999, 99999, {}, "x")).toEqual([]);
  });
});
