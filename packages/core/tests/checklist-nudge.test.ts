import { test, expect, describe } from "bun:test";
import { checklistOpenNudge } from "../src/loop/session";

describe("checklistOpenNudge (Phase B messaging)", () => {
  test("gate-green / checklist-open without task_complete this turn", () => {
    const msg = checklistOpenNudge({
      openCount: 2,
      calledTaskComplete: false,
    });

    expect(msg).toMatch(/Gate is GREEN/i);
    expect(msg).toMatch(/2 open/i);
    expect(msg).toMatch(/did not call task_complete/i);
    expect(msg).toMatch(/BOTH gate green AND every checklist/i);
  });

  test("gate-green / checklist-open after some completes", () => {
    const msg = checklistOpenNudge({
      openCount: 1,
      calledTaskComplete: true,
    });

    expect(msg).toMatch(/Continue with the next open item/i);
    expect(msg).not.toMatch(/did not call task_complete/i);
  });
});
