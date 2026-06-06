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
  });

  const b = summaries.find((s) => s.label === "b");

  expect(b?.passRate).toBe(1);
  expect(b?.runs).toBe(1);
});
