import { test, expect } from "bun:test";
import { parkOrRaiseHand, raiseHandQuestion } from "../src/loop/raise-hand";
import type { IHandoff } from "../src/loop/loop.types";

// WS-C3: at a stuck terminal, an UNATTENDED build parks (today's behaviour, unchanged);
// a build with a human co-pilot present RAISES A HAND instead — poses the block and pauses.
// These lock the pure decision away from the Session's pendingAskUser/event side effects.

function handoff(over: Partial<IHandoff> = {}): IHandoff {
  return {
    block: "react-component-architecture/component-folder-structure",
    rungHistory: ["R1", "R2", "R3"],
    errors: [
      "no-untranslated-jsx-text: wrap the label in t(...)",
      "component-folder-structure: move Button into its own folder",
    ],
    ask: "The folder-structure rule keeps failing and I can't tell the intended layout.",
    resumable: true,
    resume: { triedLevers: ["R1", "R2", "R3"] },
    ...over,
  };
}

test("unattended (no human) PARKS byte-identically: stuck + the handoff, no question", () => {
  const h = handoff();
  const { result, question } = parkOrRaiseHand(h, false, 42);

  expect(result.status).toBe("stuck");
  expect(result.turns).toBe(42);
  expect(result.handoff).toBe(h);
  expect(result.awaitingUser).toBeUndefined();
  expect(question).toBeUndefined();
});

test("human present RAISES A HAND: responded + awaitingUser question, no park", () => {
  const { result, question } = parkOrRaiseHand(handoff(), true, 7);

  // Terminal-for-now, same shape as the ask_user tool pause (the REPL surfaces it and
  // routes the next line as the answer).
  expect(result.status).toBe("responded");
  expect(result.turns).toBe(7);
  expect(result.handoff).toBeUndefined();
  expect(result.awaitingUser).toBe(question);
  // The question carries the block's ask and its errors so the human can decide.
  expect(question).toContain("folder-structure rule keeps failing");
  expect(question).toContain("How should I proceed?");
});

test("the question includes the persisting errors, capped, with an overflow note", () => {
  const many = handoff({
    ask: "",
    errors: ["e1", "e2", "e3", "e4", "e5", "e6"],
  });
  const q = raiseHandQuestion(many);

  // Capped at RAISE_HAND_ERRORS_SHOWN (4) with a "…and N more".
  expect(q).toContain("e1");
  expect(q).toContain("e4");
  expect(q).not.toContain("e5");
  expect(q).toContain("…and 2 more");
  // A synthetic block with an empty ask still gets a non-blank request.
  expect(q).toContain("exhausted my automatic fixes");
});
