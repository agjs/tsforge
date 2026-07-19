import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";

// WS-C2: the loop must CONSUME the ask_user sentinel — end the send and surface the
// question — not feed the sentinel back to the model. Without this, WS-C1's tool is
// inert (the panel's dead-code finding). These drive real Session turns.

/** A provider that calls ask_user on its FIRST turn, then reports done. `calls`
 *  records how many times it was invoked (to prove the send ENDED after the ask). */
function askingProvider(state: { calls: number }): IProvider {
  return {
    async complete(_messages: IChatMessage[]) {
      state.calls += 1;

      if (state.calls === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "ask_user",
              arguments: { question: "Postgres or MySQL for this app?" },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };
}

test("interactive: an ask_user call ENDS the send and emits the question event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ask-"));
  const events: ILoopEvent[] = [];
  const state = { calls: 0 };

  try {
    const session = await Session.create({
      provider: askingProvider(state),
      cwd: dir,
      files: ["**/*"],
      interactive: true,
      report: (e) => events.push(e),
    });

    const res = await session.send("build it");

    // The send ended after the ask (the model was NOT re-invoked to continue past it).
    expect(state.calls).toBe(1);
    // The question was surfaced as an ask_user event for the REPL to render.
    const ask = events.find((e) => e.kind === "ask_user");

    expect(ask?.message).toContain("Postgres or MySQL");
    // A normal "your turn" result — the human's next send carries the answer.
    expect(res.status).toBe("responded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interactive: the model receives a CLEAN tool result, never the raw sentinel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ask-"));
  const captured: { toolResult: string | null } = { toolResult: null };

  // Turn 1 asks; turn 2 (the 'answer' send) inspects what the model was fed for the
  // ask_user tool_call — it must be the clean wait-message, not the pause sentinel.
  let turn = 0;
  const provider: IProvider = {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "1", name: "ask_user", arguments: { question: "which db?" } },
          ],
        };
      }

      const toolMsg = messages.find((m) => m.role === "tool");

      captured.toolResult =
        typeof toolMsg?.content === "string" ? toolMsg.content : null;

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      interactive: true,
    });

    await session.send("build it"); // turn 1: ask → send ends
    await session.send("Postgres"); // turn 2: the human's answer → continues

    expect(captured.toolResult).not.toBeNull();
    expect(captured.toolResult).toContain("posed to the human");
    expect(captured.toolResult).not.toContain("<<<ASK_USER>>>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless (no interactive): ask_user does NOT pause — the run proceeds, never hangs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ask-"));
  const events: ILoopEvent[] = [];
  const state = { calls: 0 };

  try {
    const session = await Session.create({
      provider: askingProvider(state),
      cwd: dir,
      files: ["**/*"],
      // interactive omitted → unattended
      report: (e) => events.push(e),
    });

    await session.send("build it");

    // ask_user returned "proceed" (not a sentinel), so the loop did NOT end early —
    // the model was invoked again and completed. No pause event.
    expect(state.calls).toBeGreaterThan(1);
    expect(events.find((e) => e.kind === "ask_user")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
