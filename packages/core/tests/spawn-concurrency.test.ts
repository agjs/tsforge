import { test, expect } from "bun:test";
import { makeLimiter } from "../src/cli/spawn-runner";

/** Resolve after a macrotask so overlapping tasks actually interleave. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The concurrency the user configures (`agents.concurrency`) becomes this
// semaphore's cap; it's what makes multiple `spawn_agent` calls in one turn
// actually overlap instead of serializing. Without it a burst would hammer the
// endpoint; with a stale cap of 1 they'd run one at a time (the bug the missing
// config-walk-up caused).
test("makeLimiter runs up to `cap` bodies at once and no more", async () => {
  const cap = 3;
  const limit = makeLimiter(cap);
  let active = 0;
  let peak = 0;

  const task = (): Promise<void> =>
    limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });

  // Fire 8 concurrently — at most `cap` may run at any instant.
  await Promise.all(Array.from({ length: 8 }, () => task()));

  expect(peak).toBe(cap);
  expect(active).toBe(0);
});

test("makeLimiter with cap 1 serializes; a higher cap overlaps", async () => {
  const serialPeak = { value: 0 };
  const parallelPeak = { value: 0 };

  const run = async (cap: number, peak: { value: number }): Promise<void> => {
    const limit = makeLimiter(cap);
    let active = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        limit(async () => {
          active += 1;
          peak.value = Math.max(peak.value, active);
          await tick();
          active -= 1;
        })
      )
    );
  };

  await run(1, serialPeak);
  await run(4, parallelPeak);

  expect(serialPeak.value).toBe(1); // cap 1 ⇒ strictly serial
  expect(parallelPeak.value).toBe(4); // cap 4 ⇒ all four overlap
});

test("makeLimiter clamps a bad cap to at least 1 (never deadlocks)", async () => {
  for (const bad of [0, -3, Number.NaN]) {
    const limit = makeLimiter(bad);
    const out = await limit(() => Promise.resolve("ok"));

    expect(out).toBe("ok");
  }
});
