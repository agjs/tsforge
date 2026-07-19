import { test, expect } from "bun:test";
import { join } from "node:path";
import { classifyReplRoute, nextAwaitingAnswer } from "../src/cli/repl";

// WS-C: the interactive REPL must offer ask_user, and it must SURVIVE /clear. The /clear
// path rebuilds Session.create WITHOUT reusing the init config, so it silently dropped
// interactive:true once (the panel caught it). Both Session.create sites in the REPL
// must set interactive:true. This source guard locks exactly that regression — the
// /clear rebuild lives inside the readline command loop and isn't unit-reachable.
test("both REPL Session.create sites (init + /clear) set interactive:true for ask_user", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  // Every Session.create in the REPL is an interactive human session.
  const createCount = (src.match(/Session\.create\(/g) ?? []).length;
  const interactiveCount = (src.match(/interactive: true/g) ?? []).length;

  expect(createCount).toBeGreaterThanOrEqual(2);
  expect(interactiveCount).toBe(createCount);
});

// The SAFETY contract, unit-tested via the pure router: while awaiting an ask_user
// answer, a plan-approval word must route to "answer", NOT "plan-approval" — else the
// human's reply would silently exit plan mode and unlock mutating tools.
test("classifyReplRoute: awaiting an answer beats plan-approval (the safety hole)", () => {
  const planState = {
    planMode: true,
    planDiscussed: true,
    awaitingAnswer: true,
  };

  // "approve"/"go" while awaiting an answer → the ANSWER, never a plan approval.
  expect(classifyReplRoute("approve", planState)).toBe("answer");
  expect(classifyReplRoute("go", planState)).toBe("answer");
  expect(classifyReplRoute("Postgres, please", planState)).toBe("answer");
});

test("classifyReplRoute: normal plan-mode routing when NOT awaiting an answer", () => {
  const base = { planMode: true, planDiscussed: true, awaitingAnswer: false };

  // Same words, but no pending question → plan approval / discussion as before.
  expect(classifyReplRoute("approve", base)).toBe("plan-approval");
  expect(classifyReplRoute("what about auth?", base)).toBe("plan-discuss");
  expect(classifyReplRoute("go", { ...base, planDiscussed: false })).toBe(
    "plan-discuss"
  ); // a stray "go" before any discussion isn't an approval

  // Outside plan mode → a normal message.
  expect(
    classifyReplRoute("hello", {
      planMode: false,
      planDiscussed: false,
      awaitingAnswer: false,
    })
  ).toBe("normal");
});

// nextAwaitingAnswer: a FAILED answer send (interrupted/stuck — Session.send returns
// these, it rarely throws) must KEEP the flag, or a retried "approve" reopens the hole.
test("nextAwaitingAnswer keeps the flag when the answer send fails, clears it on success", () => {
  // New pause → true.
  expect(
    nextAwaitingAnswer(false, { status: "responded", awaitingUser: "q?" })
  ).toBe(true);
  // Failed answer send → keep waiting (answer not delivered).
  expect(nextAwaitingAnswer(true, { status: "interrupted" })).toBe(true);
  expect(nextAwaitingAnswer(true, { status: "stuck" })).toBe(true);
  // Completed answer send (no new pause) → cleared.
  expect(nextAwaitingAnswer(true, { status: "responded" })).toBe(false);
  expect(nextAwaitingAnswer(true, { status: "done" })).toBe(false);
});
