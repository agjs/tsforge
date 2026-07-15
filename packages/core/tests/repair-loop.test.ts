import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, LOOP_LIMITS } from "../src/loop";
import { STEER_LADDER_MAX } from "../src/loop/feedback/steer";
import { scripted, runStep, STOP } from "./stub-provider";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-repair-"));
}

test("reaches done after running a fix then stopping", async () => {
  const dir = await tmp();

  try {
    // Run a command that creates the marker, then stop → gate runs → green.
    const provider = scripted([runStep("echo x > fixed.txt"), STOP]);
    const r = await runTask(
      { id: "1", accept: "test -f fixed.txt", files: [] },
      dir,
      provider
    );

    expect(r.status).toBe("done");
    expect(r.cycles).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the gate overrides a false 'done' — loop continues until really green", async () => {
  const dir = await tmp();

  try {
    // Turn 1 claims done with nothing created (gate red); then it actually fixes.
    const provider = scripted([STOP, runStep("echo x > fixed.txt"), STOP]);
    const r = await runTask(
      { id: "1", accept: "test -f fixed.txt", files: [] },
      dir,
      provider
    );

    expect(r.status).toBe("done");
    expect(r.cycles).toBe(3); // the premature STOP did not end it
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists well past the old 6-cycle cap while it keeps working", async () => {
  const dir = await tmp();

  try {
    // 8 no-op turns of real work, then the fix, then stop → done at turn 10.
    const steps = [
      ...Array.from({ length: 8 }, () => runStep("true")),
      runStep("echo x > fixed.txt"),
      STOP,
    ];
    const r = await runTask(
      { id: "1", accept: "test -f fixed.txt", files: [] },
      dir,
      scripted(steps)
    );

    expect(r.status).toBe("done");
    expect(r.cycles).toBe(10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stuck when it claims done but the gate stays red, unchanged", async () => {
  const dir = await tmp();

  try {
    // Always stops without fixing → gate red with the SAME error every time. The
    // per-(file,rule) guard trips every `samePersist` cycles, but instead of an
    // instant kill the loop now ESCALATES a steer each time and resets — so it only
    // PARKS after the ladder is exhausted, at `samePersist × (STEER_LADDER_MAX + 1)`
    // cycles. Still bounded, well before any raw turn cap; the model just gets more
    // (escalating) chances first.
    const r = await runTask(
      { id: "1", accept: "test -f never.txt", files: [] },
      dir,
      scripted([STOP])
    );

    expect(r.status).toBe("stuck");
    expect(r.reason).toBe("handoff");
    // Parked at the top of the ladder: the first stall is detected patiently
    // (samePersist), then steering escalates fast (steerRetrigger) to the park — so
    // it stops in a handful of cycles, well before any raw turn cap.
    expect(r.cycles).toBeGreaterThanOrEqual(LOOP_LIMITS.samePersist);
    expect(r.cycles).toBeLessThanOrEqual(
      LOOP_LIMITS.samePersist +
        LOOP_LIMITS.steerRetrigger * (STEER_LADDER_MAX + 1)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stuck immediately when the streamed model response degenerates", async () => {
  const dir = await tmp();

  try {
    const r = await runTask(
      { id: "1", accept: "test -f never.txt", files: [] },
      dir,
      {
        async complete() {
          return {
            content: "I will fix it.\nI will fix it.\n",
            toolCalls: [],
            degenerated: true,
          };
        },
      }
    );

    expect(r.status).toBe("stuck");
    expect(r.reason).toBe("handoff");
    expect(r.handoff?.block).toBe("degeneration");
    expect(r.cycles).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
