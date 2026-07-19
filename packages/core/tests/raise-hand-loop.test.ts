import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";

// WS-C3: a stuck terminal RAISES A HAND (pause + ask) when a human co-pilot is present,
// and PARKS (today's behaviour) when unattended. Driven end-to-end through the real
// read-only-spin terminal: a provider that only ever calls a read-only tool exhausts the
// spin guard, which is one of the terminals WS-C3 hooks. (Ladder-exhaustion is the other,
// harder to force deterministically; the park-vs-ask DECISION for both is unit-locked in
// raise-hand.test.ts.)

/** A provider that never edits — it just reads the same file forever, driving the loop
 *  into the read-only spin that ends in a stuck terminal. */
function spinningReader(): IProvider {
  return {
    async complete() {
      return {
        content: "",
        toolCalls: [
          { id: "r", name: "read", arguments: { file: "readme.txt" } },
        ],
      };
    },
  };
}

async function spinDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-raisehand-"));

  await writeFile(join(dir, "readme.txt"), "hello\n");

  return dir;
}

test("interactive: a read-only spin RAISES A HAND instead of parking", async () => {
  const dir = await spinDir();
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: spinningReader(),
      cwd: dir,
      files: ["**/*"],
      interactive: true, // co-pilot present
      maxTurns: 60, // enough turns for the spin (streak 12 × recoveries) to exhaust
      report: (e) => events.push(e),
    });

    const res = await session.send("build it");

    // Raise-hand terminal: the send pauses for the human, it does NOT park stuck.
    expect(res.status).toBe("responded");
    expect(res.awaitingUser).toBeDefined();
    expect(res.awaitingUser).toContain("How should I proceed?");
    // The question was surfaced as an ask_user event for the REPL to render.
    expect(events.some((e) => e.kind === "ask_user")).toBe(true);
    // A raise-hand is not a park — no handoff on the result.
    expect(res.handoff).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unattended: the SAME read-only spin PARKS (stuck + handoff), never asks", async () => {
  const dir = await spinDir();
  const events: ILoopEvent[] = [];

  try {
    const session = await Session.create({
      provider: spinningReader(),
      cwd: dir,
      files: ["**/*"],
      // interactive omitted → headless/unattended
      maxTurns: 60,
      report: (e) => events.push(e),
    });

    const res = await session.send("build it");

    // Today's park, unchanged: stuck with the structured handoff, no raise-hand.
    expect(res.status).toBe("stuck");
    expect(res.handoff).toBeDefined();
    expect(res.awaitingUser).toBeUndefined();
    expect(events.some((e) => e.kind === "ask_user")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
