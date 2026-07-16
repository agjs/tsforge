import { test, expect, describe } from "bun:test";
import { nearGreenBanner } from "../src/loop/turn";

describe("nearGreenBanner (finishing discipline near green)", () => {
  test("far from green, no regression → no banner", () => {
    expect(nearGreenBanner(10, 10)).toBe("");
  });

  test("first red cycle (best is Infinity) → no banner", () => {
    expect(nearGreenBanner(5, Number.POSITIVE_INFINITY)).toBe("");
  });

  test("near green → lockdown banner (no new fronts)", () => {
    const b = nearGreenBanner(2, 2);

    expect(b).toContain("NEAR-GREEN");
    expect(b).toContain("Do NOT create new files");
    expect(b).not.toContain("REGRESSION");
  });

  test("regressed above best but not near → regression callout", () => {
    // The bshands10 t139 case: was 1, sprayed to 6.
    const b = nearGreenBanner(6, 1);

    expect(b).toContain("REGRESSION");
    expect(b).toContain("were at 1 error(s), now 6");
    expect(b).not.toContain("NEAR-GREEN");
  });

  test("regressed AND still near → both callouts", () => {
    const b = nearGreenBanner(3, 1);

    expect(b).toContain("REGRESSION");
    expect(b).toContain("NEAR-GREEN");
  });

  test("at the watermark, far from green → no banner", () => {
    expect(nearGreenBanner(5, 5)).toBe("");
  });
});
