import { test, expect, describe } from "bun:test";
import {
  isEphemeralUserInject,
  isGateFeedbackInject,
  isHarnessUserInject,
} from "../src/loop/harness-inject";
import { checklistOpenNudge } from "../src/loop/session";

describe("isEphemeralUserInject", () => {
  test("filters checklist snapshots and the Phase B nudge", () => {
    expect(
      isEphemeralUserInject({
        role: "user",
        content: "## Active plan checklist (revision 3)\ngoal: x",
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
        content: "## Active plan checklist (revision 1)\ngoal: nope",
      })
    ).toBe(false);
  });
});

describe("isGateFeedbackInject", () => {
  test("matches settle acceptance walls only", () => {
    expect(
      isGateFeedbackInject({
        role: "user",
        content:
          "The acceptance command still fails:\n- boom\n\nFix your editable files and run it again.",
      })
    ).toBe(true);
    expect(
      isGateFeedbackInject({
        role: "user",
        content: "You started repeating yourself. STOP — do not re-explain",
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

  test("flags the anti-patch PATCH-UNTIL-GREEN lead", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content:
          "⚠ PATCH-UNTIL-GREEN — the same error keeps surviving under a near-green count. " +
          "Your approach is wrong, not just one character off.",
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

  test("flags Detected packs: activation notice", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content:
          "Detected packs: env-access, generic-ts (newly activated: env-access). " +
          "The task-contract Check: line now matches this live gate.",
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

  test("checklist snapshots are harness (and ephemeral)", () => {
    expect(
      isHarnessUserInject({
        role: "user",
        content: "## Active plan checklist (revision 3)\ngoal: x",
      })
    ).toBe(true);
  });
});
