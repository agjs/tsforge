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

  expect(outcome.error).toBeInstanceOf(Error);
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
  expect(outcome.error).toBeUndefined();
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
