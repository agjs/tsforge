import { test, expect } from "bun:test";
import {
  doAskUser,
  isAskUserResult,
  askUserQuestion,
  ASK_USER_SENTINEL,
  ASK_USER_NO_HUMAN,
} from "../src/loop/tools/ask-user-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";

/** Minimal structural ctx — only what doAskUser reads. `humanPresent` toggles the two
 *  behaviours. Built structurally (no cast) so it tracks the real interface. */
function ctx(humanPresent: boolean): IToolContext {
  return {
    cwd: "/workspace",
    files: [],
    report: () => undefined,
    task: "ask-test",
    humanPresent,
  };
}

test("interactive: doAskUser returns the pause sentinel carrying the question", () => {
  const out = doAskUser(
    { question: "Postgres or MySQL for this resource?" },
    ctx(true)
  );

  expect(isAskUserResult(out)).toBe(true);
  expect(askUserQuestion(out)).toBe("Postgres or MySQL for this resource?");
  expect(out).toBe(`${ASK_USER_SENTINEL}Postgres or MySQL for this resource?`);
});

test("UNATTENDED: doAskUser never hangs — it returns the proceed-with-judgment message", () => {
  const out = doAskUser({ question: "which database?" }, ctx(false));

  expect(out).toBe(ASK_USER_NO_HUMAN);
  // Crucially NOT a pause sentinel — an eval/CI run must continue, not wait.
  expect(isAskUserResult(out)).toBe(false);
});

test("interactive default off: a ctx without `interactive` is treated as unattended", () => {
  const bare: IToolContext = {
    cwd: "/workspace",
    files: [],
    report: () => undefined,
    task: "t",
  };

  expect(doAskUser({ question: "x?" }, bare)).toBe(ASK_USER_NO_HUMAN);
});

test("an empty question is rejected with guidance, in either mode", () => {
  expect(doAskUser({ question: "   " }, ctx(true))).toContain("non-empty");
  expect(doAskUser({}, ctx(true))).toContain("non-empty");
});

test("askUserQuestion returns empty for a non-sentinel result", () => {
  expect(askUserQuestion("just a normal tool result")).toBe("");
  expect(isAskUserResult("just a normal tool result")).toBe(false);
});
