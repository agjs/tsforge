import { test, expect } from "bun:test";
import { summarize } from "../src/eval";

test("aggregates run records per variant label", () => {
  const summaries = summarize([
    { label: "a", passed: true, cycles: 2, ms: 100, quality: 4 },
    { label: "a", passed: false, cycles: 4, ms: 300 },
    { label: "b", passed: true, cycles: 1, ms: 50, quality: 2 },
  ]);

  const a = summaries.find((s) => s.label === "a");

  expect(a).toMatchObject({
    runs: 2,
    passed: 1,
    passRate: 0.5,
    avgCycles: 3,
    avgMs: 200,
    avgQuality: 4,
    // passed run took 2 cycles; the failed run's 4 are excluded from T2G.
    avgTurnsToGreen: 2,
  });

  const b = summaries.find((s) => s.label === "b");

  expect(b?.passRate).toBe(1);
  expect(b?.runs).toBe(1);
  expect(b?.avgTurnsToGreen).toBe(1);
});

// A sweep that cannot see cost compares variants on pass-rate and turns alone, so a
// variant that passes slightly more often while burning several times the tokens
// reads as a straight win. These fields are the other half of that comparison.
test("averages cost over the runs that recorded it, not over all runs", () => {
  const summaries = summarize([
    { label: "a", passed: true, cycles: 2, ms: 100, tokensOut: 1000 },
    { label: "a", passed: true, cycles: 2, ms: 100, tokensOut: 3000 },
    // Errored before spending anything: it records no tokens, and must NOT be
    // averaged in as a zero — that would report a variant as cheaper the more
    // often it crashed.
    { label: "a", passed: false, cycles: 0, ms: 0 },
  ]);
  const a = summaries.find((s) => s.label === "a");

  expect(a?.avgTokensOut).toBe(2000);
  expect(a?.runs).toBe(3);
});

// Prompt cost is the half output tokens hide: a variant can enlarge the prompt or
// tool context on every call while tokensOut stays flat.
test("averages prompt tokens over the runs that recorded them", () => {
  const summaries = summarize([
    { label: "a", passed: true, cycles: 1, ms: 1, tokensIn: 1000 },
    { label: "a", passed: true, cycles: 1, ms: 1, tokensIn: 3000 },
    // No prompt figure: must not be averaged in as a zero.
    { label: "a", passed: false, cycles: 0, ms: 0 },
  ]);
  const a = summaries.find((s) => s.label === "a");

  expect(a?.avgTokensIn).toBe(2000);
});

test("averages cost-per-accepted-change independently of token totals", () => {
  const summaries = summarize([
    {
      label: "a",
      passed: true,
      cycles: 2,
      ms: 100,
      tokensOut: 900,
      costPerAcceptedChange: 300,
    },
    // Same tokens, nothing accepted → no ratio recorded, so it cannot drag the
    // per-change figure toward zero.
    { label: "a", passed: false, cycles: 5, ms: 100, tokensOut: 900 },
  ]);
  const a = summaries.find((s) => s.label === "a");

  expect(a?.avgCostPerAcceptedChange).toBe(300);
  expect(a?.avgTokensOut).toBe(900);
});

test("reports zero cost only when no run recorded any", () => {
  const summaries = summarize([{ label: "a", passed: true, cycles: 1, ms: 1 }]);
  const a = summaries.find((s) => s.label === "a");

  expect(a?.avgTokensOut).toBe(0);
  expect(a?.avgCostPerAcceptedChange).toBe(0);
});
