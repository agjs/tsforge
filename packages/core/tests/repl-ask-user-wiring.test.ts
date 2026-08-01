import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  classifyReplRoute,
  nextAwaitingAnswer,
  humanAtKeyboard,
} from "../src/cli/repl";

// WS-C: the interactive REPL must offer ask_user, and it must SURVIVE /clear. The /clear
// path rebuilds Session.create WITHOUT reusing the init config, so it silently dropped
// interactive once (the panel caught it). Both Session.create sites must gate interactive
// on humanAtKeyboard() — a TTY (so a piped/non-TTY REPL, with no human to answer, never
// advertises a pause nobody can resume). This source guard locks both regressions — the
// /clear rebuild lives inside the readline command loop and isn't unit-reachable.
test("both REPL Session.create sites (init + /clear) gate interactive on humanAtKeyboard()", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  // Every Session.create in the REPL is interactive-WHEN-a-human-is-present.
  const createCount = (src.match(/Session\.create\(/g) ?? []).length;
  const interactiveCount = (
    src.match(/interactive: humanAtKeyboard\(\)/g) ?? []
  ).length;

  expect(createCount).toBeGreaterThanOrEqual(2);
  expect(interactiveCount).toBe(createCount);
});

// #103: the scoped format janitor is opt-in (coreFormat). The interactive REPL enables it,
// and — like `interactive` — the /clear rebuild does NOT reuse the init config, so a rebuild
// that dropped the flag would silently revert the session to no formatting. Every REPL
// Session.create MUST set coreFormat:true. Source-guarded (the /clear rebuild lives in the
// readline loop, not unit-reachable); Session.create's PROPAGATION of the flag is behavior-
// tested in format-wiring.test.ts.
test("both REPL Session.create sites (init + /clear) enable coreFormat", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  const createCount = (src.match(/Session\.create\(/g) ?? []).length;
  const coreFormatCount = (src.match(/coreFormat: true/g) ?? []).length;

  expect(createCount).toBeGreaterThanOrEqual(2);
  expect(coreFormatCount).toBe(createCount);
});

// WS-C: /clear rebuilds the Session, and the gate fires on mutation state (`edited`), not
// a dirty tree — so a rebuild that dropped the deferred-gate flag would silently skip
// re-validating an on-disk pre-pause edit. The /clear path must read session.hasDeferredGate
// and pass pausedWithEdit into the new session. Source-guarded (the /clear rebuild lives in
// the readline loop, not unit-reachable); the create-option BEHAVIOR is tested in
// ask-user-loop.test.ts.
test("/clear carries the deferred gate across the Session rebuild", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  expect(src).toContain("session.hasDeferredGate");
  expect(src).toContain("pausedWithEdit: carryDeferredGate");
});

// WS-C: the deferred gate must ALSO survive the process boundary (--continue / --resume),
// not just the in-process /clear. The persist path writes session.hasDeferredGate into the
// record and the resumed Session.create re-seeds pausedWithEdit from it — else a resumed
// session drops the deferred gate (session-store.test.ts locks the record round-trip).
test("--continue persists + re-seeds the deferred gate", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "src", "cli", "repl.ts")
  ).text();

  // Written into the persisted record…
  expect(src).toContain("pausedWithEdit: session.hasDeferredGate");
  // …and re-seeded on the resumed Session.create.
  expect(src).toContain("resumed?.pausedWithEdit === true");
});

// WS-C: humanAtKeyboard() is the safety gate that stops a piped/non-TTY REPL from
// advertising ask_user (no human → EOF ends the REPL mid-question). Lock the isTTY
// truthiness contract behaviorally, not just via the source-string guard: true → present;
// undefined (Node's real non-TTY value) / false → absent.
test("humanAtKeyboard reflects stdin.isTTY: true → present, undefined/false → absent", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  const set = (value: unknown): void => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  try {
    set(true);
    expect(humanAtKeyboard()).toBe(true);
    // A piped stream: Node reports `undefined` (not false) at runtime.
    set(undefined);
    expect(humanAtKeyboard()).toBeFalsy();
    set(false);
    expect(humanAtKeyboard()).toBe(false);
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", original);
    }
  }
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

// nextAwaitingAnswer: a NO-PROGRESS failed answer send (turns 0 — Session.send returns
// interrupted/stuck with turns 0 on abort/provider error) must KEEP the flag, or a
// retried "approve" reopens the hole. But a send that RAN (turns > 0) consumed the
// answer — even a later ladder-exhaustion stuck — so the flag must clear, else plan
// approval is stranded.
test("nextAwaitingAnswer keeps the flag only on a no-progress failed send", () => {
  // New pause → true.
  expect(
    nextAwaitingAnswer(false, { status: "responded", awaitingUser: "q?" })
  ).toBe(true);
  // Failed answer send that made no progress (turns 0) → keep (answer not processed).
  expect(nextAwaitingAnswer(true, { status: "interrupted", turns: 0 })).toBe(
    true
  );
  expect(nextAwaitingAnswer(true, { status: "stuck", turns: 0 })).toBe(true);
  // A stuck AFTER a full build (turns > 0) CONSUMED the answer → clear (don't strand
  // plan approval).
  expect(nextAwaitingAnswer(true, { status: "stuck", turns: 40 })).toBe(false);
  // Completed answer send (no new pause) → cleared.
  expect(nextAwaitingAnswer(true, { status: "responded", turns: 3 })).toBe(
    false
  );
  expect(nextAwaitingAnswer(true, { status: "done", turns: 5 })).toBe(false);
});
