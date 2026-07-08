import { test, expect } from "bun:test";
import { makeLimiter, makeSpawnAgentFn } from "../src/cli/spawn-runner";
import { BUILTIN_SPECS } from "../src/agent/builtin-specs";
import type { ILoopEvent } from "../src/loop";

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

test("makeLimiter releases the slot even when a body throws (no deadlock)", async () => {
  const limit = makeLimiter(1);

  await expect(limit(() => Promise.reject(new Error("boom")))).rejects.toThrow(
    "boom"
  );

  // If the throwing body leaked its slot, this second task would hang forever.
  expect(await limit(() => Promise.resolve("ok"))).toBe("ok");
});

test("an aborted signal returns an aborted result WITHOUT running the agent", async () => {
  const kinds: string[] = [];
  const fn = makeSpawnAgentFn({
    specs: BUILTIN_SPECS,
    cwd: process.cwd(),
    concurrency: 2,
    policyMode: "bypassPermissions",
  });
  const ac = new AbortController();

  ac.abort();

  const out = await fn(
    {
      subagentType: "explore",
      description: "d",
      prompt: "p",
      parentTaskId: "t",
    },
    {
      signal: ac.signal,
      report: (e: ILoopEvent) => {
        kinds.push(e.kind);
      },
    }
  );

  expect(out).toContain("aborted");
  // Only lifecycle events — the model was never resolved or called.
  expect(kinds).toEqual(["agent_spawned", "agent_result"]);
});
