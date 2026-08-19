import { test, expect, describe } from "bun:test";
import {
  summarizeAxeViolations,
  checkPerfBudget,
  axeOutcomeToErrors,
} from "../src/browser/oracle";
import { parseChecks } from "../src/browser/checks";

// The pure pass/fail-deciding helpers of the browser oracle: they decide whether
// a11y / perf budgets go green or red, yet had ZERO coverage. No browser needed,
// so these run in the default suite (the in-browser behaviours are opt-in).

describe("summarizeAxeViolations", () => {
  test("only serious/critical impacts become errors", () => {
    const out = summarizeAxeViolations(
      [
        { id: "color-contrast", impact: "serious", nodeCount: 2 },
        { id: "region", impact: "moderate", nodeCount: 1 },
        { id: "label", impact: "critical", nodeCount: 3 },
        { id: "x", impact: "minor", nodeCount: 9 },
      ],
      "index"
    );

    expect(out).toHaveLength(2);
    expect(out.join(" ")).toContain("color-contrast");
    expect(out.join(" ")).toContain("label");
    expect(out.join(" ")).not.toContain("region");
    expect(out.join(" ")).not.toContain("minor");
  });

  test("an undefined impact never gates", () => {
    expect(
      summarizeAxeViolations(
        [{ id: "x", impact: undefined, nodeCount: 1 }],
        "p"
      )
    ).toEqual([]);
  });

  test("no violations → no errors", () => {
    expect(summarizeAxeViolations([], "index")).toEqual([]);
  });
});

describe("checkPerfBudget", () => {
  test("flags DOM node count over budget", () => {
    const out = checkPerfBudget(1500, 100, { maxDomNodes: 1000 }, "index");

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("1500 DOM nodes > budget 1000");
  });

  test("flags mount time over budget", () => {
    const out = checkPerfBudget(10, 2500, { maxMountMs: 2000 }, "index");

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("mount 2500ms > budget 2000ms");
  });

  test("under budget (and boundary equality) → no errors", () => {
    expect(
      checkPerfBudget(1000, 2000, { maxDomNodes: 1000, maxMountMs: 2000 }, "p")
    ).toEqual([]);
  });

  test("an unset budget field never gates", () => {
    expect(checkPerfBudget(9999, 9999, {}, "index")).toEqual([]);
  });
});

describe("axeOutcomeToErrors (S5)", () => {
  test("unavailable (dep absent) → skip, no errors", () => {
    expect(axeOutcomeToErrors({ kind: "unavailable" }, "index")).toEqual([]);
  });

  test("a crashed analyze surfaces as an error — never a silent clean", () => {
    const out = axeOutcomeToErrors(
      { kind: "error", message: "CSP blocked axe inject" },
      "index"
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("a11y check failed to run at index");
    expect(out[0]).toContain("CSP blocked axe inject");
  });

  test("ok with serious violations → gate errors", () => {
    const out = axeOutcomeToErrors(
      {
        kind: "ok",
        result: {
          violations: [{ id: "label", impact: "critical", nodes: [{}, {}] }],
        },
      },
      "index"
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("label");
  });

  test("ok with no violations → clean", () => {
    expect(
      axeOutcomeToErrors({ kind: "ok", result: { violations: [] } }, "index")
    ).toEqual([]);
  });
});

describe("parseChecks", () => {
  test("parses a full expect + steps payload", () => {
    const parsed = parseChecks({
      expect: { selector: "#x", text: "ok" },
      steps: [
        { click: "#inc", expect: { selector: "#n", text: "1" } },
        { fill: { selector: "#in", value: "hi" } },
      ],
    });

    expect(parsed.expect).toEqual({ selector: "#x", text: "ok" });
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps?.[0]).toEqual({
      click: "#inc",
      expect: { selector: "#n", text: "1" },
    });
    expect(parsed.steps?.[1]).toEqual({
      fill: { selector: "#in", value: "hi" },
    });
  });

  test("non-object / garbage input → empty parse (no throw)", () => {
    expect(parseChecks(null)).toEqual({});
    expect(parseChecks("nope")).toEqual({});
    expect(parseChecks(42)).toEqual({});
    expect(parseChecks([])).toEqual({});
  });

  test("drops malformed steps and mistyped fields, keeps valid ones", () => {
    const parsed = parseChecks({
      expect: { selector: 5, text: "keep" }, // selector wrong type → dropped
      steps: [
        { click: 10 }, // wrong type → whole step empty → dropped
        { fill: { selector: "#in" } }, // missing value → fill dropped → step empty → dropped
        { click: "#ok" }, // valid
      ],
    });

    expect(parsed.expect).toEqual({ text: "keep" });
    expect(parsed.steps).toEqual([{ click: "#ok" }]);
  });

  test("empty expect object and empty steps are omitted", () => {
    expect(parseChecks({ expect: {}, steps: [] })).toEqual({});
  });
});
