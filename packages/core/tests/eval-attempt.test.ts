import { test, expect } from "bun:test";
import { recordAttempt } from "../src/eval";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { IRunRecord } from "../src/eval";

function usageEvent(completionTokens: number): ILoopEvent {
  return {
    kind: "usage",
    task: "t",
    message: "tokens",
    promptTokens: 100,
    completionTokens,
    totalTokens: 100 + completionTokens,
  };
}

// This is the crash accounting the eval:sweep campaign and the self-harness
// evaluator both use. Each had written its own and each got it wrong the same way:
// a throw recorded ms: 0 with no tokens, so a variant that died after burning model
// calls read as instant and free — better the more often it crashed.
test("a thrown attempt records the time and tokens it consumed", async () => {
  const events: ILoopEvent[] = [];
  let clock = 0;

  const outcome = await recordAttempt({
    label: "git=on temp=0",
    events,
    elapsedMs: () => clock,
    run: async () => {
      // The attempt reports usage, then dies — the shape the old code discarded.
      events.push(usageEvent(400), usageEvent(600));
      clock = 8500;

      throw new Error("endpoint exploded");
    },
  });

  expect(outcome.failed).toBe(true);
  expect(outcome.failed && outcome.error).toBeInstanceOf(Error);
  expect(outcome.record.ms).toBe(8500);
  expect(outcome.record.tokensOut).toBe(1000);
  expect(outcome.record.tokensIn).toBe(200);
  expect(outcome.record.passed).toBe(false);
});

// The sweep labelled successes from the env vars and failures from the feature
// dimensions, so one variant split into two summarize() buckets and its own crashes
// never counted against its pass rate.
test("a failure is filed under the SAME label as a success", async () => {
  const success: IRunRecord = {
    label: "git=on temp=0",
    passed: true,
    cycles: 2,
    ms: 10,
  };
  const ok = await recordAttempt({
    label: "git=on temp=0",
    events: [],
    elapsedMs: () => 10,
    run: async () => success,
  });
  const failed = await recordAttempt({
    label: "git=on temp=0",
    events: [],
    elapsedMs: () => 10,
    run: async () => {
      throw new Error("boom");
    },
  });

  expect(failed.record.label).toBe(ok.record.label);
});

test("a successful attempt is returned untouched, with no error", async () => {
  const record: IRunRecord = {
    label: "a",
    passed: true,
    cycles: 3,
    ms: 99,
    tokensOut: 5,
  };
  const outcome = await recordAttempt({
    label: "a",
    events: [usageEvent(9999)],
    elapsedMs: () => 1,
    run: async () => record,
  });

  // The run's own record wins — the caller's clock/events are the FALLBACK for a
  // throw, not an override of a completed run.
  expect(outcome.record).toEqual(record);
  expect(outcome.failed).toBe(false);
});

test("an attempt that dies before spending anything records no cost", async () => {
  const outcome = await recordAttempt({
    label: "a",
    events: [],
    elapsedMs: () => 40,
    run: async () => {
      throw new Error("died in setup");
    },
  });

  expect(outcome.record.ms).toBe(40);
  expect(outcome.record.tokensOut).toBeUndefined();
  expect(outcome.record.costPerAcceptedChange).toBeUndefined();
});

// `error` cannot discriminate success from failure: a rejection can CARRY undefined.
// Keying off its presence made `throw undefined` look like a success, so the caller
// filed an infrastructure crash as an ordinary red task and never counted it errored.
test("a rejection carrying undefined is still a failure", async () => {
  // Typed as Error so the no-non-Error-throw rules are satisfied, but the RUNTIME
  // value is undefined/null/0/"" — which is the whole point: `error !== undefined`
  // could not tell those apart from a success.
  const values: Error[] = [undefined, null, 0, ""].map(
    (v) => v as unknown as Error
  );

  for (const thrown of values) {
    const outcome = await recordAttempt({
      label: "a",
      events: [],
      elapsedMs: () => 12,
      run: async () => {
        throw thrown;
      },
    });

    expect({ thrown, failed: outcome.failed }).toEqual({
      thrown,
      failed: true,
    });
    expect(outcome.record.passed).toBe(false);
    expect(outcome.record.errored).toBe(true);
  }
});
