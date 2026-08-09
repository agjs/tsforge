import { test, expect, describe } from "bun:test";
import {
  isEphemeralUserInject,
  isHarnessUserInject,
} from "../src/loop/harness-inject";
import { checklistOpenNudge } from "../src/loop/session";

describe("isEphemeralUserInject", () => {
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

describe("isHarnessUserInject", () => {
  test("flags NEAR-GREEN / gate-feedback injects (not human speech)", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content:
          "⚠ NEAR-GREEN — only 1 error(s) from done. Fix ONLY the error(s)\n\n" +
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      })
    ).toBe(true);
    expect(
      isHarnessUserInject({
        role: "user",
        content:
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      })
    ).toBe(true);
  });

  test("flags resteers and plan-approved notes", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content: "You started repeating yourself. STOP — do not re-explain",
      })
    ).toBe(true);
    expect(
      isHarnessUserInject({
        role: "user",
        content: "Your plan is APPROVED — saved as this session's checklist",
      })
    ).toBe(true);
  });

  test("keeps real human prompts as non-harness", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content: "Build a tiny notes CLI",
      })
    ).toBe(false);
  });

  test("checklist injects are harness (and ephemeral)", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content: "[checklist — session plan abc]\ngoal: x",
      })
    ).toBe(true);
  });
});
