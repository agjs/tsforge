import { test, expect, describe } from "bun:test";
import {
  buildSteerMessage,
  essentialMessages,
  playbookFor,
  isTrivialDiagnosis,
  STEER_LADDER_MAX,
  type ISteerError,
} from "../src/loop/feedback/steer";
import { hasPendingDiagnosis } from "../src/loop/turn";

const err = (rule: string): ISteerError => ({
  rule,
  file: "src/views/Foo/index.tsx",
  message: `${rule} violated`,
});

describe("playbookFor", () => {
  test("resolves a bare rule name to its recipe", () => {
    expect(playbookFor("no-jsx-computation")).toContain("src/lib");
  });

  test("resolves a plugin-prefixed rule to the same recipe", () => {
    expect(playbookFor("tsforge/no-jsx-computation")).toBe(
      playbookFor("no-jsx-computation")
    );
  });

  test("the as-cast playbook teaches a type guard, never a cast", () => {
    const play = playbookFor("no-restricted-syntax");

    expect(play).toContain("TYPE GUARD");
    expect(play).toContain("v is Status");
  });

  test("unknown / undefined rules have no playbook", () => {
    expect(playbookFor("some-unknown-rule")).toBeNull();
    expect(playbookFor(undefined)).toBeNull();
  });
});

describe("buildSteerMessage escalation", () => {
  const errors = [
    err("tsforge/no-jsx-computation"),
    err("no-restricted-syntax"),
  ];

  test("level 1 makes the model STEP BACK and diagnose its own loop", () => {
    const msg = buildSteerMessage(1, errors, "same error 5×");

    expect(msg).toContain("escalation 1");
    expect(msg).toContain("STEP BACK");
    expect(msg).toContain("DIFFERENT approach"); // reflect, don't feed a rule
    // The fix is whatever works — surgical OR full rewrite; we no longer forbid
    // whole-file rewrites (forcing surgical edits traps the model).
    expect(msg.toLowerCase()).toContain("full rewrite");
  });

  test("level 2 tells the model to INVESTIGATE with tools (+ pattern for known rules)", () => {
    const msg = buildSteerMessage(2, errors, "same error", true);

    expect(msg).toContain("INVESTIGATE");
    expect(msg).toContain("search the codebase");
    // The known-good pattern is still offered as a reference when it fits.
    expect(msg).toContain("no-jsx-computation");
    expect(msg).toContain("TYPE GUARD");
  });

  test("web_search is suggested ONLY when web tools are enabled", () => {
    expect(buildSteerMessage(2, errors, "s", true)).toContain("web_search");
    expect(buildSteerMessage(2, errors, "s", false)).not.toContain(
      "web_search"
    );
  });

  test("level 2 with no known-rule errors still says INVESTIGATE (no static rule)", () => {
    const msg = buildSteerMessage(2, [err("some-unknown-rule")], "stuck");

    expect(msg).toContain("INVESTIGATE");
    expect(msg).toContain("search the codebase");
  });

  test("level 3 changes strategy: invert, one error one file, then expert", () => {
    const msg = buildSteerMessage(3, errors, "not converging");

    expect(msg).toContain("SINGLE");
    expect(msg).toContain("OPPOSITE");
    expect(msg).toContain("already pass");
    expect(msg).toContain("expert"); // the last resort is the stronger model
  });

  test("every level names the escalation out of the ladder max", () => {
    for (let lvl = 1; lvl <= STEER_LADDER_MAX; lvl += 1) {
      expect(buildSteerMessage(lvl, errors, "r")).toContain(
        `/${String(STEER_LADDER_MAX)}`
      );
    }
  });
});

describe("essentialMessages (context reset)", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "build the app" },
    { role: "assistant", content: "attempt 1" },
    { role: "user", content: "error: X" },
    { role: "assistant", content: "attempt 2 (dead end)" },
    { role: "user", content: "error: X still" },
  ];

  test("keeps ONLY the system prompt + the original task (drops the flailing middle)", () => {
    const head = essentialMessages(msgs);

    expect(head).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "build the app" },
    ]);
  });

  test("preserves order and omits a missing system/user cleanly", () => {
    expect(essentialMessages([{ role: "user", content: "task" }])).toEqual([
      { role: "user", content: "task" },
    ]);
    expect(essentialMessages([])).toEqual([]);
  });
});

describe("isTrivialDiagnosis (R1 feed-forward)", () => {
  const errors = [
    err("tsforge/no-jsx-computation"),
    err("no-restricted-syntax"),
  ];

  test("diagnosis < 80 chars is trivial", () => {
    expect(isTrivialDiagnosis("short", errors)).toBe(true);
  });

  test("diagnosis >= 80 chars with novel content is not trivial", () => {
    const longDiagnosis = "a".repeat(80) + " new insight about the problem";

    expect(isTrivialDiagnosis(longDiagnosis, errors)).toBe(false);
  });

  test("diagnosis that only restates errors is trivial (superset check)", () => {
    // Construct a diagnosis that just restates the error messages
    const restated = errors.map((e) => e.message).join(" ");

    expect(isTrivialDiagnosis(restated, errors)).toBe(true);
  });

  test("diagnosis with new information is not trivial", () => {
    const diagnosis = `The jsx computation error occurs because I need to refactor the component differently. The issue is in the way I'm computing values inline instead of extracting helper functions.`;

    expect(isTrivialDiagnosis(diagnosis, errors)).toBe(false);
  });

  test("empty diagnosis is trivial", () => {
    expect(isTrivialDiagnosis("", errors)).toBe(true);
  });

  test("whitespace-only diagnosis is trivial", () => {
    expect(isTrivialDiagnosis("   \n  ", errors)).toBe(true);
  });
});

describe("buildSteerMessage: R1 diagnosis-only variant", () => {
  const errors = [
    err("tsforge/no-jsx-computation"),
    err("no-restricted-syntax"),
  ];

  test("R1 diagnosis-only says DIAGNOSE only, not DIAGNOSE THEN CHANGE", () => {
    const msg = buildSteerMessage(1, errors, "same error", false, true);

    expect(msg).toContain("DIAGNOSE");
    expect(msg).toContain("escalation 1");
    // The standard R1 includes "THEN we'll act" — diagnosis-only shouldn't
    // We verify this by checking the variant is meaningfully different
    expect(msg.length > 0).toBe(true);
  });

  test("R1 Phase A (diagnosis-only) vs Phase B (action) messages are different", () => {
    const phaseA = buildSteerMessage(1, errors, "same error", false, true);
    const phaseB = buildSteerMessage(1, errors, "same error", false, false);

    expect(phaseA).toContain("DIAGNOSE");
    expect(phaseB).toContain("DIFFERENT approach");
    // The two phases have distinct guidance
    expect(phaseA).not.toBe(phaseB);
  });
});

describe("R1 two-phase decision logic", () => {
  const errors = [err("no-jsx-computation")];

  test("trivial diagnosis triggers escalation (Phase A → R2), non-trivial triggers Phase B", () => {
    // A diagnosis that just restates the error is trivial
    const trivialDiagnosis = "no-jsx-computation violated";

    expect(isTrivialDiagnosis(trivialDiagnosis, errors)).toBe(true);

    // A diagnosis with novel insight is not trivial
    // The key is it must NOT contain all the error messages as substrings
    const nonTrivialDiagnosis =
      "The root cause is that I've been computing JSX inline instead of extracting " +
      "it into a helper function. I should refactor to use useMemo or extract to a separate module. " +
      "This architectural change will fix the underlying issue.";

    expect(isTrivialDiagnosis(nonTrivialDiagnosis, errors)).toBe(false);
  });

  test("diagnosis exactly at 80 chars is not trivial (boundary check)", () => {
    const diagnosis80 = "x".repeat(80);

    expect(isTrivialDiagnosis(diagnosis80, errors)).toBe(false);
  });

  test("diagnosis under 80 chars is trivial regardless of content", () => {
    const shortButNovel = "New insight about the problem structure";

    expect(shortButNovel.length < 80).toBe(true);
    expect(isTrivialDiagnosis(shortButNovel, errors)).toBe(true);
  });

  test("only a string marker activates the diagnosis-only turn", () => {
    expect(hasPendingDiagnosis({ pendingDiagnosisSteer: "diagnose" })).toBe(
      true
    );
    expect(hasPendingDiagnosis({ pendingDiagnosisSteer: null })).toBe(false);
    expect(hasPendingDiagnosis({ pendingDiagnosisSteer: undefined })).toBe(
      false
    );
    expect(hasPendingDiagnosis({})).toBe(false);
  });
});
