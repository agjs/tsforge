import { expect, test } from "bun:test";
import { pool } from "./pool";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("resolves in input order regardless of completion order", async () => {
  const delays = [40, 5, 25, 1];
  const tasks = delays.map((d) => async () => {
    await tick(d);

    return d;
  });

  expect(await pool(tasks, 4)).toEqual([40, 5, 25, 1]);
});

test("never exceeds the concurrency limit", async () => {
  let live = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, () => async () => {
    live += 1;
    peak = Math.max(peak, live);
    await tick(10);
    live -= 1;

    return 1;
  });

  await pool(tasks, 3);

  expect(peak).toBe(3);
});

test("starts the next task as a slot frees, not in batches", async () => {
  // With batching, a slow first task blocks the whole batch and the fast ones
  // finish late. Sliding start: task 3 begins while task 0 is still running.
  const startedAt: number[] = [];
  const t0 = Date.now();
  const tasks = [80, 5, 5, 5].map((d) => async () => {
    startedAt.push(Date.now() - t0);
    await tick(d);

    return d;
  });

  await pool(tasks, 2);

  expect(startedAt).toHaveLength(4);
  // The 4th task must start well before the 80ms task finishes.
  expect(startedAt[3]).toBeLessThan(60);
});

test("settles every task before rejecting, and aggregates in input order", async () => {
  const finished: number[] = [];
  const tasks = [
    async () => {
      await tick(5);

      throw new Error("first");
    },
    async () => {
      await tick(30);
      finished.push(1);

      return 1;
    },
    async () => {
      await tick(10);

      throw new Error("third");
    },
  ];

  const err = await pool(tasks, 3).then(
    () => null,
    (e: unknown) => e
  );
  const messages =
    err instanceof AggregateError
      ? err.errors.map((e: Error) => e.message)
      : null;

  expect(err).toBeInstanceOf(AggregateError);
  expect(messages).toEqual(["first", "third"]);
  // The slow success ran to completion before the pool gave up.
  expect(finished).toEqual([1]);
});

test("aborts running tasks on the first rejection", async () => {
  let aborted = false;
  const tasks = [
    async () => {
      await tick(5);

      throw new Error("boom");
    },
    async (signal: AbortSignal) => {
      await tick(40);
      aborted = signal.aborted;

      return 0;
    },
  ];

  await pool(tasks, 2).catch(() => undefined);

  expect(aborted).toBe(true);
});

test("never starts queued tasks once the pool has aborted", async () => {
  let started = 0;
  const tasks = [
    async () => {
      await tick(5);

      throw new Error("boom");
    },
    async () => {
      await tick(50);

      return 0;
    },
    async () => {
      started += 1;

      return 0;
    },
  ];

  await pool(tasks, 2).catch(() => undefined);

  expect(started).toBe(0);
});

test("empty input resolves empty", async () => {
  expect(await pool([], 4)).toEqual([]);
});

test("a limit above the task count is fine", async () => {
  const tasks = [async () => 1, async () => 2];

  expect(await pool(tasks, 99)).toEqual([1, 2]);
});

test("rejects a bad limit synchronously, before running anything", () => {
  let ran = false;
  const tasks = [
    async () => {
      ran = true;

      return 1;
    },
  ];

  expect(() => pool(tasks, 0)).toThrow(RangeError);
  expect(() => pool(tasks, 1.5)).toThrow(RangeError);
  expect(ran).toBe(false);
});
