import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateHarness } from "../src/self-harness";
import { buildRunRecord } from "../src/eval";
import type { IModelResponse, IProvider } from "../src/inference";
import { editStep, STOP } from "./stub-provider";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

/** [file, stub body, correct body] — a tuple list rather than a lookup, so no
 *  entry needs a non-null assertion to use. */
const FIXTURES = [
  [
    "add.ts",
    "export function add(_a: number, _b: number): number {\n  return 0;\n}",
    "export function add(a: number, b: number): number {\n  return a + b;\n}",
  ],
  [
    "mul.ts",
    "export function mul(_amount: number, _qty: number): number {\n  return 0;\n}",
    "export function mul(amount: number, qty: number): number {\n  return amount * qty;\n}",
  ],
] as const;

/** A scripted provider that also reports token usage, so the run produces the
 *  `usage` events the cost metrics are derived from. */
function scriptedWithUsage(
  steps: IModelResponse[],
  perCall: number
): IProvider {
  let i = 0;

  return {
    async complete() {
      const step = steps[Math.min(i, steps.length - 1)] ?? {
        content: "",
        toolCalls: [],
      };

      i += 1;

      return {
        ...step,
        usage: {
          promptTokens: 500,
          completionTokens: perCall,
          totalTokens: 500 + perCall,
        },
      };
    },
  };
}

// evaluateHarness had NO test, which is how `ms: 0` sat hardcoded in every record
// while avgMs presented as a measurement, and how the token cost the metrics
// library already computed never reached the record. Both are invisible to a unit
// test — only a real run shows a fabricated zero.
test("a completed evaluation records real elapsed time and token cost", async () => {
  const runsDir = await mkdtemp(join(tmpdir(), "tsforge-selfeval-"));

  try {
    const outcome = await evaluateHarness(["math"], {
      corpusDir: CORPUS,
      runsDir,
      provider: scriptedWithUsage(
        FIXTURES.flatMap(([file, stub, fixed]) => [
          editStep(file, stub, fixed),
          STOP,
        ]),
        700
      ),
      repeats: 1,
      overlay: null,
    });

    const [record] = outcome.records;

    expect(outcome.records.length).toBe(1);
    expect(record).toBeDefined();
    // Real wall-clock, not the hardcoded 0 this used to report.
    expect(record?.ms ?? 0).toBeGreaterThan(0);
    // The cost side of the comparison, derived from the run's usage events —
    // which the headless loop did not emit at all until this change.
    expect(record?.tokensOut ?? 0).toBeGreaterThan(0);
    // costPerAcceptedChange needs an ACCEPTED edit, which a scripted run cannot
    // be relied on to produce here — it is pinned directly below instead.
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}, 120000);

// The record's metric half, pinned directly: an end-to-end run cannot be relied on
// to produce an accepted edit, and without this deleting the cost wiring from
// runTaskOnce would leave the suite green.
test("buildRunRecord carries cost, and omits the ratio when nothing was accepted", () => {
  const withCost = buildRunRecord({
    label: "t",
    passed: true,
    cycles: 3,
    elapsedMs: 1234,
    metrics: { tokensOut: 9000, costPerAcceptedChange: 3000 },
  });

  expect(withCost).toEqual({
    label: "t",
    passed: true,
    cycles: 3,
    ms: 1234,
    tokensOut: 9000,
    costPerAcceptedChange: 3000,
  });

  // Tokens spent but nothing survived: the ratio is undefined, not zero. Recording
  // 0 would be averaged in and make a variant look cheaper the less of its work
  // stuck.
  const nothingAccepted = buildRunRecord({
    label: "t",
    passed: false,
    cycles: 9,
    elapsedMs: 50,
    metrics: { tokensOut: 9000, costPerAcceptedChange: 0 },
  });

  expect(nothingAccepted.tokensOut).toBe(9000);
  expect(nothingAccepted.costPerAcceptedChange).toBeUndefined();

  // A run that never reached the model records neither.
  const spentNothing = buildRunRecord({
    label: "t",
    passed: false,
    cycles: 0,
    elapsedMs: 7,
    metrics: { tokensOut: 0, costPerAcceptedChange: 0 },
  });

  expect(spentNothing.tokensOut).toBeUndefined();
  expect(spentNothing.ms).toBe(7);
});

// A run that dies after doing work must still report the time it burned. Recording
// `ms: 0` for it made an unreliable variant look FASTER the more often it crashed
// — the same bias the token averages are careful to avoid.
test("an errored run records the time it actually consumed", async () => {
  const runsDir = await mkdtemp(join(tmpdir(), "tsforge-selferr-"));

  try {
    const outcome = await evaluateHarness(["math"], {
      corpusDir: CORPUS,
      runsDir,
      provider: {
        async complete() {
          await new Promise((resolve) => setTimeout(resolve, 60));

          throw new Error("endpoint exploded");
        },
      },
      repeats: 1,
      overlay: null,
    });

    const [record] = outcome.records;

    expect(record?.passed).toBe(false);
    expect(record?.ms ?? 0).toBeGreaterThan(0);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}, 120000);
