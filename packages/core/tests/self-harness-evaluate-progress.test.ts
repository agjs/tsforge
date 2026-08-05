import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateHarness } from "../src/self-harness";
import type { IModelResponse, IProvider } from "../src/inference";

/**
 * The PRODUCTION path: does `evaluateHarness` actually put a graded score on
 * every run and aggregate it onto the split?
 *
 * Three reviewers flagged that the unit tests exercised the scoring functions
 * and the acceptance rule, but nothing exercised the wiring between them — the
 * loop tests inject a fake evaluator, so `runTaskOnce` and `evaluateHarness`
 * were untested. A score that is computed correctly and never recorded is worth
 * exactly nothing to the acceptance rule.
 */

/** A model that refuses to act, so the task fails with the gate still red —
 *  which is the case whose score used to be indistinguishable from zero. */
function inertProvider(): IProvider {
  return {
    complete: (): Promise<IModelResponse> =>
      Promise.resolve({ content: "I will not.", toolCalls: [] }),
  };
}

/** A one-task scratch corpus whose test cannot pass without a source file, so a
 *  run that writes nothing ends red with a known error count. */
async function corpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-progress-corpus-"));
  const task = join(dir, "tiny");

  await mkdir(task, { recursive: true });
  await writeFile(
    join(task, "tiny.spec.md"),
    [
      "---",
      "id: tiny",
      "title: Tiny",
      "verify: bun test",
      "mode: scratch",
      "---",
      "",
      "## Acceptance criteria",
      "",
      "A1. `answer()` returns 42.",
      "",
      "## Tasks",
      "",
      "1. [tiny] Implement answer",
      "   accept: bun test answer.test.ts",
      "   files: answer.ts",
      "   context: answer.test.ts",
      "",
    ].join("\n")
  );
  await writeFile(
    join(task, "answer.test.ts"),
    [
      'import { test, expect } from "bun:test";',
      'import { answer } from "./answer";',
      "",
      'test("answers", () => {',
      "  expect(answer()).toBe(42);",
      "});",
      "",
    ].join("\n")
  );
  await writeFile(
    join(task, "answer.ts"),
    "export function answer() {\n  return 42;\n}\n"
  );

  return dir;
}

describe("evaluateHarness records the graded score", () => {
  test("a failed run carries a progress number, and the split aggregates it", async () => {
    const corpusDir = await corpus();
    const runsDir = await mkdtemp(join(tmpdir(), "tsforge-progress-runs-"));

    try {
      const out = await evaluateHarness(["tiny"], {
        corpusDir,
        runsDir,
        provider: inertProvider(),
        repeats: 1,
        overlay: null,
      });

      expect(out.score.runs).toBe(1);
      expect(out.score.passed).toBe(0);

      // The whole point of the change: the record carries a graded figure
      // rather than only `passed: false`.
      const record = out.records[0];

      expect(record).toBeDefined();

      // Pin the SEMANTICS, not just the type. A model that writes nothing
      // resolves nothing, so this must be exactly 0 — and critically NOT 1,
      // which is the defect class that nearly shipped (a failed run scoring
      // what a pass scores).
      expect(record?.progress).toBe(0);
      expect(record?.progress).not.toBe(1);

      // And it reaches the split score the acceptance rule actually reads.
      expect(out.score.avgProgress).toBe(0);
    } finally {
      await rm(corpusDir, { recursive: true, force: true });
      await rm(runsDir, { recursive: true, force: true });
    }
  }, 120_000);
});
