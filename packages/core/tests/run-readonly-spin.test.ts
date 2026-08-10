import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, LOOP_LIMITS } from "../src/loop";
import { STUCK_REASON } from "../src/loop/loop.constants";
import type { ILoopEvent } from "../src/loop/loop.types";
import { scripted, runStep, createStep, STOP } from "./stub-provider";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-readonly-"));
}

test("read-only-spin: detects N consecutive read-only turns and re-steers before backstop", async () => {
  const dir = await tmp();

  try {
    // A model that only calls read/search tools (run steps) without ever editing.
    // With READONLY_STREAK_LIMIT=12, hot streak after resteer, MAX_READONLY_RECOVERIES=2:
    // - Turn 12: re-steer (recovery 1), streak stays hot (limit-1)
    // - Turn 13: re-steer (recovery 2)
    // - Turn 14: recoveries exhausted → stop with readonly-spin
    // This should happen well before maxTurns=40.
    const readonlySteps = Array.from({ length: 40 }, () =>
      runStep("cat /dev/null")
    );
    const provider = scripted([...readonlySteps, STOP]);
    const r = await runTask(
      { id: "1", accept: "test -f never.txt", files: ["**/*"] },
      dir,
      provider
    );

    expect(r.status).toBe("stuck");
    // Should not have looped all the way to the backstop cap
    expect(r.cycles).toBeLessThan(LOOP_LIMITS.maxTurns);
    // Should have exhausted recoveries, not just hit the turn cap
    expect(r.reason).toBe(STUCK_REASON.readonlySpin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only-spin: resets streak when a tool call touches an editable file", async () => {
  const dir = await tmp();

  try {
    // Verify the streak resets on edit by checking we can read far beyond the
    // limit WITHOUT hitting readonly-spin IF there's an edit in between. Create
    // a sequence that would hit readonly-spin if streak didn't reset:
    // - Turns 1-11: read-only (streak under limit of 12)
    // - Turn 12: edit (reset streak to 0)
    // - Turns 13-23: read-only (under limit again)
    // - Turn 24: edit (reset again)
    // - Turns 25+: a few more reads, then stop
    // If streak DIDN'T reset on edits, turn 12 would already trip the spin.
    const steps = [
      ...Array.from({ length: 11 }, () => runStep("cat /dev/null")),
      createStep("x.txt", "x"), // turn 12: reset streak
      ...Array.from({ length: 11 }, () => runStep("cat /dev/null")),
      createStep("y.txt", "y"), // turn 24: reset streak again
      ...Array.from({ length: 3 }, () => runStep("cat /dev/null")), // turns 25-27
      STOP, // turn 28: gate runs, stays red → stuck (normal for red gate)
    ];
    const provider = scripted(steps);
    const r = await runTask(
      { id: "1", accept: "test -f never.txt", files: ["**/*"] },
      dir,
      provider
    );

    // Should NOT be readonly-spin (would have fired at turn 36 if streaks didn't reset).
    // Instead, it either hits the backstop or the normal stalled guard.
    expect(r.status).toBe("stuck");
    expect(r.reason).not.toBe(STUCK_REASON.readonlySpin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat: emits EXACTLY ONE checkpoint event per interval (no duplicate)", async () => {
  const dir = await tmp();

  try {
    // Read-only turns with a small checkpointIntervalTurns=3: the heartbeat must
    // fire ONCE per interval (turns 3, 6, 9, …) until a stall guard ends the run.
    // The bug this guards is a DUPLICATE emission — two identical blocks firing the
    // same checkpoint twice per interval (e.g. [3, 3, 6, 6]). We assert the emitted
    // turns are all on-cadence and contain NO repeats, independent of exactly when
    // the run stops.
    const steps = Array.from({ length: 7 }, () => runStep("cat /dev/null"));
    const events: ILoopEvent[] = [];
    const provider = scripted([...steps, STOP]);

    await runTask(
      { id: "1", accept: "test -f never.txt", files: ["**/*"] },
      dir,
      provider,
      { checkpointIntervalTurns: 3, onEvent: (e) => events.push(e) }
    );

    const checkpointTurns = events
      .filter((e) => e.kind === "checkpoint")
      .map((e) => e.cycle);

    // At least one interval elapsed.
    expect(checkpointTurns.length).toBeGreaterThan(0);
    // No duplicates — a double-emission would repeat a turn value.
    expect(new Set(checkpointTurns).size).toBe(checkpointTurns.length);

    // Every checkpoint lands exactly on the interval cadence.
    for (const turn of checkpointTurns) {
      expect(turn === undefined ? -1 : turn % 3).toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
