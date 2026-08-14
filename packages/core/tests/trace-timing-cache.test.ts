import { test, expect, describe } from "bun:test";
import { analyzeEvents } from "../src/eval";
import { parseEventLog } from "../src/eval/parse-log";
import type { ILoopEvent } from "../src/loop/loop.types";

function usage(over: Partial<ILoopEvent> = {}): ILoopEvent {
  return {
    kind: "usage",
    task: "t",
    message: "",
    promptTokens: 1000,
    completionTokens: 10,
    totalTokens: 1010,
    ...over,
  };
}

/**
 * Both metrics went missing on a run that cost half its wall clock to a
 * prefix-cache bug: the trace printed `prefix cache —` while every call had
 * logged its hit rate, and reported 664s of model time against 2645s of actual
 * calls because `ms` measures generation only.
 */
describe("the trace reports cache hits from a log", () => {
  test("parseEventLog carries cachedPromptTokens", () => {
    const line = JSON.stringify({
      type: "model_call_finished",
      payload: {
        kind: "usage",
        task: "t",
        message: "",
        promptTokens: 1000,
        cachedPromptTokens: 900,
        completionTokens: 10,
      },
    });

    const [event] = parseEventLog(line);

    // Dropping this field is why a logged 88% hit rate rendered as "—".
    expect(event?.cachedPromptTokens).toBe(900);
  });

  test("a run's hit rate survives the log round-trip", () => {
    const lines = [
      { promptTokens: 1000, cachedPromptTokens: 0 },
      { promptTokens: 1000, cachedPromptTokens: 800 },
    ]
      .map((p) =>
        JSON.stringify({
          type: "model_call_finished",
          payload: { kind: "usage", task: "t", message: "", ...p },
        })
      )
      .join("\n");

    const m = analyzeEvents(parseEventLog(lines));

    expect(m.cacheHitRate).toBeCloseTo(0.4, 5);
  });
});

describe("the trace reports what a call really cost", () => {
  test("call time counts prefill, which `ms` excludes", () => {
    // The logged extreme: a 168s call that reported 6.7s of generation.
    const m = analyzeEvents([usage({ ms: 6_700, callMs: 168_500 })]);

    expect(m.modelCallMs).toBe(168_500);
    expect(m.prefillMs).toBe(161_800);
  });

  test("no generation time means no invented prefill split", () => {
    // The headless path reports callMs without ms. `callMs - 0` would claim the
    // whole call was prefill — a confident wrong number.
    const m = analyzeEvents([usage({ callMs: 3_414 })]);

    expect(m.modelCallMs).toBe(3_414);
    expect(m.prefillMs).toBe(0);
  });

  test("callMs survives the log round-trip", () => {
    const line = JSON.stringify({
      type: "model_call_finished",
      payload: {
        kind: "usage",
        task: "t",
        message: "",
        promptTokens: 10,
        ms: 100,
        callMs: 5_000,
      },
    });

    const m = analyzeEvents(parseEventLog(line));

    expect(m.modelCallMs).toBe(5_000);
    expect(m.prefillMs).toBe(4_900);
  });

  test("a run with no timing at all reports none", () => {
    const m = analyzeEvents([usage()]);

    expect(m.modelCallMs).toBe(0);
    expect(m.prefillMs).toBe(0);
  });
});
