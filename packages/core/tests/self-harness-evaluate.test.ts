import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateHarness } from "../src/self-harness";
import type { IModelResponse, IProvider } from "../src/inference";
import { editStep, STOP } from "./stub-provider";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

const STUB_FN: Record<string, string> = {
  "add.ts":
    "export function add(_a: number, _b: number): number {\n  return 0;\n}",
  "mul.ts":
    "export function mul(_amount: number, _qty: number): number {\n  return 0;\n}",
};

const FIXED_FN: Record<string, string> = {
  "add.ts":
    "export function add(a: number, b: number): number {\n  return a + b;\n}",
  "mul.ts":
    "export function mul(amount: number, qty: number): number {\n  return amount * qty;\n}",
};

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
        [
          editStep("add.ts", STUB_FN["add.ts"]!, FIXED_FN["add.ts"]!),
          STOP,
          editStep("mul.ts", STUB_FN["mul.ts"]!, FIXED_FN["mul.ts"]!),
          STOP,
        ],
        700
      ),
      repeats: 1,
      overlay: null,
    });

    expect(outcome.records.length).toBe(1);

    const record = outcome.records[0]!;

    // Real wall-clock, not the hardcoded 0 this used to report.
    expect(record.ms).toBeGreaterThan(0);
    // The cost side of the comparison, derived from the run's usage events.
    expect(record.tokensOut ?? 0).toBeGreaterThan(0);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}, 120000);
