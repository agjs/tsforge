import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, LOOP_LIMITS } from "../src/loop";
import { STUCK_REASON } from "../src/loop/loop.constants";
import { scripted, runStep, createStep, STOP } from "./stub-provider";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-readonly-"));
}

test("read-only-spin: detects N consecutive read-only turns and re-steers before backstop", async () => {
  const dir = await tmp();

  try {
    // A model that only calls read/search tools (run steps) without ever editing.
    // With READONLY_STREAK_LIMIT=12 and MAX_READONLY_RECOVERIES=2:
    // - Turn 12: re-steer (recovery 1), reset streak
    // - Turn 24 (12 more): re-steer (recovery 2), reset streak
    // - Turn 36 (12 more): hit MAX_READONLY_RECOVERIES → stop with readonly-spin
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
    // - Turns 1-11: read-only (streak 1-11, under limit)
    // - Turn 12: edit (reset streak to 0)
    // - Turns 13-23: read-only (streak 1-11 after reset, under limit)
    // - Turn 24: edit (reset again)
    // - Turns 25+: read-only (would eventually hit limit if not reset, but stop early)
    // If streak DIDN'T reset on edits, turn 23 would already be at 22 (past limit of 12).
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
