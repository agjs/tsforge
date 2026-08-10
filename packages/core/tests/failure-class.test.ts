import { test, expect, describe } from "bun:test";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { ErrorSet } from "../src/validate/validate.types";
import {
  attributionLeadIn,
  classifyFromGate,
  classifyRun,
  FAILURE_CLASS,
} from "../src/eval/failure-class";
import { parseEventLog } from "../src/eval/parse-log";

function ev(
  kind: ILoopEvent["kind"],
  over: Partial<ILoopEvent> = {}
): ILoopEvent {
  return { kind, task: "1", message: "", ...over };
}

const STUCK = ev("stuck", { message: "gate unchanged 10x" });

describe("classifyRun", () => {
  test("a green run classifies as none", () => {
    const out = classifyRun([ev("cycle"), ev("done", { message: "done" })]);

    expect(out.failureClass).toBe(FAILURE_CLASS.none);
  });

  test("gate red dominated by tsc codes → type-error with commonest code", () => {
    const out = classifyRun([
      ev("validated", {
        passed: false,
        rules: ["TS18048", "TS18048", "TS2345"],
      }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.typeError);
    expect(out.detail).toBe("TS18048");
  });

  test("gate red dominated by eslint rules → lint-rule with commonest rule", () => {
    const out = classifyRun([
      ev("validated", {
        passed: false,
        rules: ["no-restricted-syntax", "no-restricted-syntax", "eqeqeq"],
      }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.lintRule);
    expect(out.detail).toBe("no-restricted-syntax");
  });

  test("Cannot find module → hallucinated-import (beats a plain type error)", () => {
    const out = classifyRun([
      ev("validated", {
        passed: false,
        rules: ["TS2307"],
        message: "red: Cannot find module './nope'",
      }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.hallucinatedImport);
  });

  test("TRANSIENT 'cannot find module' (resolved by the terminal turn) does NOT mask the real gate cause", () => {
    // A multi-file task: an early turn red'd with a missing sibling import, then
    // the model created it. The run's TERMINAL cause is a test-sibling deadlock
    // (lint rule). The stale early "cannot find module" must NOT win — it was a
    // whole-transcript text-scan artifact (the auth/checkout sweep bug).
    const out = classifyRun([
      ev("validated", {
        passed: false,
        rules: ["TS2307"],
        message: "red: Cannot find module './sessions'",
      }),
      ev("validated", {
        passed: false,
        rules: ["test-sibling-required", "test-sibling-required"],
        message: "Missing test for a logic file you changed.",
      }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.lintRule);
    expect(out.detail).toBe("test-sibling-required");
  });

  test("repair events with no gate errors → tool-malformed", () => {
    const out = classifyRun([
      ev("repair", { message: "edit:L3-re-ask" }),
      ev("repair", { message: "create:missing-arg" }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.toolMalformed);
  });

  test("rejected edits with no gate errors → edit-reject (edit channel)", () => {
    const out = classifyRun([
      ev("edit", { message: "src/x.ts — rejected (not-found)" }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.editReject);
  });

  test("dispatcher tool-channel rejections also classify as edit-reject", () => {
    // tool-context.ts emits these on kind:"tool", not kind:"edit".
    expect(
      classifyRun([ev("tool", { message: "tool_input_rejected:edit" }), STUCK])
        .failureClass
    ).toBe(FAILURE_CLASS.editReject);

    expect(
      classifyRun([
        ev("tool", { message: "tool_rejected:edit (out of scope)" }),
        STUCK,
      ]).failureClass
    ).toBe(FAILURE_CLASS.editReject);
  });

  test("repeated request timeout → timeout (outranks a stale gate error)", () => {
    const out = classifyRun([
      ev("validated", { passed: false, rules: ["TS18048"] }),
      ev("stuck", {
        message:
          "⚠ model request timed out repeatedly (TimeoutError) — stopped.",
      }),
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.timeout);
  });

  test("a transient timeout re-steer does NOT classify as timeout", () => {
    // The per-turn "re-steering (1/3)" message must not trip the terminal signal.
    const out = classifyRun([
      ev("tool", {
        message: "⚠ model request timed out (TimeoutError) — re-steering (1/3)",
      }),
      ev("done", { message: "done" }),
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.none);
  });

  test("repetition-loop stop → degeneration (real terminal messages)", () => {
    // run.ts / session.ts say "repetition loop", never "degenerate".
    expect(
      classifyRun([
        ev("stuck", {
          message:
            "model fell into a repetition loop - stopped. Try a smaller task.",
        }),
      ]).failureClass
    ).toBe(FAILURE_CLASS.degeneration);

    // Outranks a stale gate error from an earlier turn.
    expect(
      classifyRun([
        ev("validated", { passed: false, rules: ["TS18048"] }),
        ev("stuck", {
          message:
            "⚠ repetition loop persisted after recovery attempts — stopped.",
        }),
      ]).failureClass
    ).toBe(FAILURE_CLASS.degeneration);
  });

  test("malformed-tool-call / narrate-instead-of-build stops → tool-malformed", () => {
    expect(
      classifyRun([
        ev("stuck", {
          message:
            "⚠ model kept emitting malformed tool-call text instead of real calls — stopped.",
        }),
      ]).failureClass
    ).toBe(FAILURE_CLASS.toolMalformed);

    expect(
      classifyRun([
        ev("stuck", {
          message:
            "⚠ model kept writing files as chat messages instead of creating them — stopped.",
        }),
      ]).failureClass
    ).toBe(FAILURE_CLASS.toolMalformed);
  });

  test("stuck with no decisive signal → no-progress", () => {
    const out = classifyRun([STUCK]);

    expect(out.failureClass).toBe(FAILURE_CLASS.noProgress);
  });

  test("browser-oracle failures (real strings) → browser-fail / route-phantom", () => {
    // "app did not mount: root is blank after load" (oracle.ts)
    expect(
      classifyRun([
        ev("validated", {
          passed: false,
          message: "app did not mount: root is blank after load",
        }),
        STUCK,
      ]).failureClass
    ).toBe(FAILURE_CLASS.browserFail);

    // "route X failed to load" / "route X rendered blank" → route-phantom
    expect(
      classifyRun([
        ev("validated", {
          passed: false,
          message: "route /reports rendered blank",
        }),
        STUCK,
      ]).failureClass
    ).toBe(FAILURE_CLASS.routePhantom);

    expect(
      classifyRun([
        ev("validated", {
          passed: false,
          message: "route /reports failed to load: TypeError",
        }),
        STUCK,
      ]).failureClass
    ).toBe(FAILURE_CLASS.routePhantom);
  });

  test("explicit finalErrors are authoritative over event rules", () => {
    const finalErrors: ErrorSet = [
      {
        key: "a.ts:3:TS2345",
        file: "a.ts",
        line: 3,
        rule: "TS2345",
        message: "x",
      },
    ];
    const out = classifyRun([STUCK], finalErrors);

    expect(out.failureClass).toBe(FAILURE_CLASS.typeError);
    expect(out.detail).toBe("TS2345");
  });
});

describe("parseEventLog", () => {
  test("parses serialized events, skips malformed lines and unknown kinds", () => {
    const jsonl = [
      JSON.stringify({
        t: 1,
        kind: "validated",
        task: "1",
        passed: false,
        rules: ["TS1"],
      }),
      "not json",
      JSON.stringify({ kind: "nonsense", task: "1" }),
      JSON.stringify({ kind: "done", task: "1", message: "done" }),
    ].join("\n");

    const events = parseEventLog(jsonl);

    expect(events.map((e) => e.kind)).toEqual(["validated", "done"]);
    expect(events[0]?.rules).toEqual(["TS1"]);
  });

  test("round-trips through classifyRun", () => {
    const jsonl = [
      JSON.stringify({
        kind: "validated",
        task: "1",
        passed: false,
        rules: ["TS18048"],
      }),
      JSON.stringify({ kind: "stuck", task: "1", message: "stalled" }),
    ].join("\n");

    expect(classifyRun(parseEventLog(jsonl)).failureClass).toBe(
      FAILURE_CLASS.typeError
    );
  });
});

describe("classifyFromGate (live settle)", () => {
  test("empty ErrorSet is none even without a done event", () => {
    expect(classifyFromGate([]).failureClass).toBe(FAILURE_CLASS.none);
  });

  test("lint-dominated ErrorSet → lint-rule with detail", () => {
    const errors: ErrorSet = [
      {
        key: "a",
        message: "no-process-exit",
        rule: "no-process-exit",
        file: "src/api.ts",
      },
      {
        key: "b",
        message: "no-process-exit",
        rule: "no-process-exit",
        file: "src/b.ts",
      },
      { key: "c", message: "eqeqeq", rule: "eqeqeq", file: "src/c.ts" },
    ];
    const out = classifyFromGate(errors);

    expect(out.failureClass).toBe(FAILURE_CLASS.lintRule);
    expect(out.detail).toBe("no-process-exit");
  });

  test("type-dominated ErrorSet → type-error", () => {
    const out = classifyFromGate([
      { key: "a", message: "TS2345", rule: "TS2345" },
      { key: "b", message: "TS2345", rule: "TS2345" },
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.typeError);
    expect(out.detail).toBe("TS2345");
  });
});

describe("attributionLeadIn", () => {
  test("none yields empty string", () => {
    expect(attributionLeadIn({ failureClass: FAILURE_CLASS.none })).toBe("");
  });

  test("lint-rule names class, detail, and forbids weakening the rule", () => {
    const line = attributionLeadIn({
      failureClass: FAILURE_CLASS.lintRule,
      detail: "no-process-exit",
    });

    expect(line).toContain("Harness attribution: lint-rule (no-process-exit)");
    expect(line).toContain("do not disable");
    expect(line).toContain("unallowlisted");
  });

  test("type-error forbids casting around the error", () => {
    expect(
      attributionLeadIn({
        failureClass: FAILURE_CLASS.typeError,
        detail: "TS2345",
      })
    ).toContain("do not cast");
  });
});
