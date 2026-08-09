import { test, expect, describe } from "bun:test";
import { checklistOpenNudge, isEphemeralUserInject } from "../src/loop/session";

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

describe("isEphemeralUserInject (resume transcript)", () => {
  test("filters per-turn checklist inject and Phase B nudge", () => {
    expect(
      isEphemeralUserInject({
        role: "user",
        content:
          "[checklist — session plan 31fbd6a0-ad34-4ad8-ad5a-efff0e8e44e5]\ngoal: x",
      })
    ).toBe(true);
    expect(
      isEphemeralUserInject({
        role: "user",
        content: checklistOpenNudge({
          openCount: 1,
          calledTaskComplete: true,
        }),
      })
    ).toBe(true);
  });

  test("keeps real user / assistant turns", () => {
    expect(
      isEphemeralUserInject({
        role: "user",
        content: "Build a notes CLI",
      })
    ).toBe(false);
    expect(
      isEphemeralUserInject({
        role: "assistant",
        content: "[checklist — session plan x]\ngoal: nope",
      })
    ).toBe(false);
  });
});
