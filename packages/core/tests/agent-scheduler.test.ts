import { test, expect, describe } from "bun:test";
import {
  AgentScheduler,
  clampConcurrency,
  type IScheduledUnit,
  type UnitStatus,
} from "../src/agent/agent-scheduler";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function unit<T>(
  id: string,
  run: (signal: AbortSignal) => Promise<T>
): IScheduledUnit<T> {
  return { id, run };
}

describe("clampConcurrency", () => {
  test("clamps junk to 1 and floors fractions", () => {
    expect(clampConcurrency(undefined)).toBe(1);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-4)).toBe(1);
    expect(clampConcurrency(3.7)).toBe(3);
    expect(clampConcurrency(Number.NaN)).toBe(1);
    expect(clampConcurrency(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampConcurrency(4)).toBe(4);
  });
});

describe("AgentScheduler.runParallel", () => {
  test("respects the concurrency cap (max in-flight never exceeds it)", async () => {
    let inFlight = 0;
    let peak = 0;
    const units = Array.from({ length: 8 }, (_, i) =>
      unit(`u${String(i)}`, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight -= 1;

        return i;
      })
    );

    const results = await new AgentScheduler({ concurrency: 3 }).runParallel(
      units
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it actually ran concurrently
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("returns results in submission order even when completion is reversed", async () => {
    // Earlier units sleep longer, so completion order is the REVERSE of
    // submission order — the result array must not care.
    const units = Array.from({ length: 4 }, (_, i) =>
      unit(`u${String(i)}`, async () => {
        await sleep((4 - i) * 15);

        return `r${String(i)}`;
      })
    );

    const results = await new AgentScheduler({ concurrency: 4 }).runParallel(
      units
    );

    expect(results).toEqual(["r0", "r1", "r2", "r3"]);
  });

  test("a throwing unit degrades to a null slot; siblings still complete", async () => {
    const results = await new AgentScheduler({ concurrency: 2 }).runParallel([
      unit("ok1", () => Promise.resolve(1)),
      unit("boom", () => Promise.reject(new Error("unit failed"))),
      unit("ok2", () => Promise.resolve(2)),
    ]);

    expect(results).toEqual([1, null, 2]);
  });

  test("master abort skips pending units (null slots) and flags unit signals", async () => {
    const ctrl = new AbortController();
    const started: string[] = [];
    const units = Array.from({ length: 6 }, (_, i) =>
      unit(`u${String(i)}`, async (signal) => {
        started.push(`u${String(i)}`);

        if (i === 0) {
          ctrl.abort(); // first unit aborts the whole fan-out
        }

        await sleep(5);

        return signal.aborted ? "aborted" : "ran";
      })
    );

    const results = await new AgentScheduler({
      concurrency: 1,
      signal: ctrl.signal,
    }).runParallel(units);

    // Only the first unit ever started; the rest were skipped as null.
    expect(started).toEqual(["u0"]);
    expect(results[0]).toBe("aborted"); // its per-unit signal fired mid-run
    expect(results.slice(1)).toEqual([null, null, null, null, null]);
  });

  test("announces every unit as pending up-front, then start→done/failed", async () => {
    const transitions: [string, UnitStatus][] = [];

    await new AgentScheduler({
      concurrency: 1,
      onUnit: (id, status) => transitions.push([id, status]),
    }).runParallel([
      unit("a", () => Promise.resolve("ok")),
      unit("b", () => Promise.reject(new Error("x"))),
    ]);

    // All pendings first (stable denominator for progress UIs), then the
    // per-unit lifecycles in schedule order.
    expect(transitions).toEqual([
      ["a", "pending"],
      ["b", "pending"],
      ["a", "start"],
      ["a", "done"],
      ["b", "start"],
      ["b", "failed"],
    ]);
  });

  test("a unit scheduled under an ALREADY-aborted master sees an aborted signal", async () => {
    const ctrl = new AbortController();

    ctrl.abort(); // aborted before runParallel is even called

    const results = await new AgentScheduler({
      concurrency: 2,
      signal: ctrl.signal,
    }).runParallel([unit("a", (signal) => Promise.resolve(signal.aborted))]);

    // The worker loop skips pending units under an aborted master entirely.
    expect(results).toEqual([null]);
  });

  test("cap>1 is genuinely faster than sequential on slow units (the mechanical speedup)", async () => {
    const make = (): IScheduledUnit<number>[] =>
      Array.from({ length: 6 }, (_, i) =>
        unit(`u${String(i)}`, async () => {
          await sleep(50);

          return i;
        })
      );

    const t1 = performance.now();

    await new AgentScheduler({ concurrency: 1 }).runParallel(make());

    const sequentialMs = performance.now() - t1;
    const t2 = performance.now();

    await new AgentScheduler({ concurrency: 3 }).runParallel(make());

    const parallelMs = performance.now() - t2;

    // 6×50ms: sequential ≈300ms, cap=3 ≈100ms. Generous margins to stay
    // flake-free under CI load — the claim is only "meaningfully faster".
    expect(sequentialMs).toBeGreaterThanOrEqual(280);
    expect(parallelMs).toBeLessThan(sequentialMs * 0.6);
  });
});
