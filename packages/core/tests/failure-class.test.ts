import { test, expect, describe } from "bun:test";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { ErrorSet } from "../src/validate/validate.types";
import { classifyRun, FAILURE_CLASS } from "../src/eval/failure-class";
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

  test("repair events with no gate errors → tool-malformed", () => {
    const out = classifyRun([
      ev("repair", { message: "edit:L3-re-ask" }),
      ev("repair", { message: "create:missing-arg" }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.toolMalformed);
  });

  test("rejected edits with no gate errors → edit-reject", () => {
    const out = classifyRun([
      ev("edit", { message: "src/x.ts — rejected (not-found)" }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.editReject);
  });

  test("degeneration message → degeneration", () => {
    const out = classifyRun([
      ev("tool", { message: "output degenerated into a loop" }),
      STUCK,
    ]);

    expect(out.failureClass).toBe(FAILURE_CLASS.degeneration);
  });

  test("stuck with no decisive signal → no-progress", () => {
    const out = classifyRun([STUCK]);

    expect(out.failureClass).toBe(FAILURE_CLASS.noProgress);
  });

  test("blank-render browser failure → browser-fail; with a route → route-phantom", () => {
    expect(
      classifyRun([
        ev("validated", { passed: false, message: "app did not render" }),
        STUCK,
      ]).failureClass
    ).toBe(FAILURE_CLASS.browserFail);

    expect(
      classifyRun([
        ev("validated", {
          passed: false,
          message: "route /reports did not render (blank)",
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
