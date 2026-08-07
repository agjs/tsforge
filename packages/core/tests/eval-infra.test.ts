import { test, expect, describe } from "bun:test";
import type { ILoopEvent } from "../src/loop/loop.types";
import type { IRunRecord } from "../src/eval";
import {
  analyzeEvents,
  buildSweepReport,
  renderSweepReportMarkdown,
  wilsonInterval,
  twoProportionZ,
} from "../src/eval";

function rec(label: string, passed: boolean): IRunRecord {
  return { label, passed, cycles: 3, ms: 1000 };
}

describe("eval report: statistics", () => {
  test("wilsonInterval handles edges and brackets the point estimate", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);

    const [lo, hi] = wilsonInterval(5, 10);

    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);

    const [lo2, hi2] = wilsonInterval(10, 10);

    expect(hi2).toBe(1);
    expect(lo2).toBeGreaterThan(0.6);
  });

  test("twoProportionZ is 0 for equal rates and large for a clear gap", () => {
    expect(twoProportionZ(5, 10, 5, 10)).toBe(0);
    expect(twoProportionZ(9, 10, 2, 10)).toBeGreaterThan(1.96);
    expect(twoProportionZ(1, 0, 1, 1)).toBe(0);
  });
});

describe("eval report: buildSweepReport", () => {
  const records: IRunRecord[] = [
    ...Array.from({ length: 10 }, (_unused, i) => rec("A", i < 2)),
    ...Array.from({ length: 10 }, (_unused, i) => rec("B", i < 9)),
  ];

  test("computes per-variant CIs and a baseline comparison", () => {
    const report = buildSweepReport(records, "A");

    expect(report.baseline).toBe("A");

    const a = report.variants.find((v) => v.label === "A");
    const b = report.variants.find((v) => v.label === "B");

    expect(a?.vsBaseline).toBeUndefined(); // baseline has no self-comparison
    expect(b?.vsBaseline?.significant).toBe(true);
    expect(b?.vsBaseline?.deltaPassRate).toBeCloseTo(0.7, 1);
    expect(b?.passRateCI[0]).toBeGreaterThan(0.5);
  });

  test("renders a Markdown table with the significance marker", () => {
    const md = renderSweepReportMarkdown(buildSweepReport(records, "A"));

    expect(md).toContain("A/B sweep report");
    expect(md).toContain("baseline");
    expect(md).toContain("*");
  });

  test("omits comparisons when no baseline matches", () => {
    const report = buildSweepReport(records);

    expect(report.baseline).toBeNull();
    expect(report.variants.every((v) => v.vsBaseline === undefined)).toBe(true);
  });
});

describe("eval metrics: analyzeEvents", () => {
  const events: ILoopEvent[] = [
    { kind: "start", task: "1", message: "", model: "m", contextWindow: 1000 },
    { kind: "cycle", task: "1", message: "", cycle: 1 },
    {
      kind: "usage",
      task: "1",
      message: "",
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      tokensPerSecond: 50,
    },
    { kind: "create", task: "1", message: "", file: "a.ts" },
    { kind: "edit", task: "1", message: "" },
    { kind: "timing", task: "1", message: "", ms: 2000 },
    { kind: "validated", task: "1", message: "", passed: true },
    { kind: "cycle", task: "1", message: "", cycle: 2 },
    {
      kind: "usage",
      task: "1",
      message: "",
      promptTokens: 700,
      completionTokens: 50,
      totalTokens: 750,
      tokensPerSecond: 30,
    },
    { kind: "done", task: "1", message: "" },
  ];

  test("distills turns, tokens, edits, gate runs, and rate", () => {
    const m = analyzeEvents(events);

    expect(m.turns).toBe(2);
    expect(m.modelCalls).toBe(2);
    expect(m.tokensOut).toBe(150);
    expect(m.peakContext).toBe(700);
    expect(m.edits).toBe(2);
    expect(m.filesCreated).toBe(1);
    expect(m.gateRuns).toBe(1);
    expect(m.turnsToGreen).toBe(2); // reached green at the `done` event, turn 2
    expect(m.wallClockSeconds).toBe(2);
    expect(m.finalStatus).toBe("done");
    expect(m.avgTokensPerSecond).toBe(40);
  });

  test("wall-clock accumulates ms then rounds once (sub-second turns don't vanish)", () => {
    // Three 400ms turns = 1200ms. Per-event rounding floored each to 0s (→ 0s
    // total); accumulate-then-round gives the correct 1s.
    const subSecond: ILoopEvent[] = [
      { kind: "timing", task: "1", message: "", ms: 400 },
      { kind: "timing", task: "1", message: "", ms: 400 },
      { kind: "timing", task: "1", message: "", ms: 400 },
    ];

    expect(analyzeEvents(subSecond).wallClockSeconds).toBe(1);
  });
});

describe("eval metrics: prefix-cache hit rate", () => {
  function usage(promptTokens: number, cached?: number): ILoopEvent {
    return {
      kind: "usage",
      task: "1",
      message: "",
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
      ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    };
  }

  test("is the token-weighted share across the run, not a mean of ratios", () => {
    // 900+100 cached of 1000+1000 prompt = 0.5. A mean of per-call rates would
    // say 0.5 too — so weight the calls unevenly to tell them apart.
    const m = analyzeEvents([usage(1000, 900), usage(100, 10)]);

    expect(m.cacheHitRate).toBeCloseTo(910 / 1100, 6);
  });

  test("is NULL when no call reported a cache figure", () => {
    // Not 0: an endpoint that never publishes the field must stay
    // distinguishable from one whose prefix actually went cold.
    expect(analyzeEvents([usage(1000), usage(500)]).cacheHitRate).toBeNull();
    expect(analyzeEvents([]).cacheHitRate).toBeNull();
  });

  test("is 0 when the server reported hits and there were none", () => {
    expect(analyzeEvents([usage(1000, 0)]).cacheHitRate).toBe(0);
  });

  test("silent calls do not dilute the calls that did report", () => {
    // One reporting call at 90%, one silent. The answer is 90%, not 45%.
    const m = analyzeEvents([usage(1000, 900), usage(1000)]);

    expect(m.cacheHitRate).toBeCloseTo(0.9, 6);
  });
});
