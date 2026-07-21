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

  test("#61: completionOnly flips the banner to BUILD the UI (not the don't-create-files lockdown)", () => {
    // The remaining error clears only by ADDING code — the normal lockdown would forbid the
    // create/edit/delete UI the feature needs. The banner must instruct the opposite.
    const b = nearGreenBanner(1, 1, true);

    expect(b).toContain("ADDING the code");
    expect(b).toContain("BUILD the");
    expect(b).toContain("NOT a regression");
    // The contradictory lockdown text must be GONE for a completion state.
    expect(b).not.toContain("Do NOT create new files");
    expect(b).not.toContain("NEAR-GREEN — only");
  });

  test("#61: completionOnly during a spike (total>best) still says BUILD, not UNDO", () => {
    // While the model adds the demanded files the count rises; it must not be told to undo.
    const b = nearGreenBanner(8, 1, true);

    expect(b).toContain("BUILD the");
    expect(b).not.toContain("REGRESSION");
    expect(b).not.toContain("UNDO");
  });

  // #77: the rotation caller now SUPPRESSES this banner entirely while rotation is active (the
  // steer owns the finishing discipline), so nearGreenBanner has no rotation-specific mode — the
  // earlier `omitLockdown` param was removed. Its behavior is exercised by the injectFeedback
  // rotation tests in near-green-rotation.test.ts.
});
