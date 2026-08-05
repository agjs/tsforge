import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateHarness } from "../src/self-harness";

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

/** A TWO-task scratch corpus, so a run can solve one task and not the other. */
async function twoTaskCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-progress-corpus2-"));
  const task = join(dir, "pair");

  await mkdir(task, { recursive: true });
  await writeFile(
    join(task, "pair.spec.md"),
    [
      "---",
      "id: pair",
      "title: Pair",
      "verify: bun test",
      "mode: scratch",
      "---",
      "",
      "## Acceptance criteria",
      "",
      "A1. `one()` returns 1. A2. `two()` returns 2.",
      "",
      "## Tasks",
      "",
      "1. [one] Implement one",
      "   accept: bun test one.test.ts",
      "   files: one.ts",
      "   context: one.test.ts",
      "",
      "2. [two] Implement two",
      "   accept: bun test two.test.ts",
      "   files: two.ts",
      "   context: two.test.ts",
      "",
    ].join("\n")
  );

  for (const [n, v] of [
    ["one", 1],
    ["two", 2],
  ] as const) {
    await writeFile(
      join(task, `${n}.test.ts`),
      [
        'import { test, expect } from "bun:test";',
        `import { ${n} } from "./${n}";`,
        "",
        `test("${n}", () => {`,
        `  expect(${n}()).toBe(${String(v)});`,
        "});",
        "",
      ].join("\n")
    );
    await writeFile(
      join(task, `${n}.ts`),
      `export function ${n}() {\n  return ${String(v)};\n}\n`
    );
  }

  return dir;
}

/** A one-task scratch corpus, used by the outage case. */
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
  test("an outage leaves avgProgress UNMEASURED, not zero", () => {
    // The finding my previous commit claimed to have fixed and had not: the
    // production call read `r.progress ?? 0`, turning errored records into
    // measured zero progress, so a split of nothing but timeouts reported 0%
    // as though it had been measured. Only a test through the real path can
    // catch that — meanProgress's own skip logic was dead code above it.
    return (async () => {
      const corpusDir = await corpus();
      const runsDir = await mkdtemp(join(tmpdir(), "tsforge-progress-err-"));

      try {
        const out = await evaluateHarness(["tiny"], {
          corpusDir,
          runsDir,
          provider: {
            complete: () => Promise.reject(new Error("endpoint is down")),
          },
          repeats: 1,
          overlay: null,
        });

        expect(out.score.errored).toBe(1);
        expect(out.score.passed).toBe(0);
        // Unmeasured, NOT zero — an outage is not a run that made no progress.
        expect(out.score.avgProgress).toBeUndefined();
      } finally {
        await rm(corpusDir, { recursive: true, force: true });
        await rm(runsDir, { recursive: true, force: true });
      }
    })();
  }, 120_000);

  test("solving one of two tasks scores in BETWEEN, not 0 and not 1", () => {
    // Guards the task-id whitelist. Asserting only "scores 0" cannot tell "no
    // progress" from "every task excluded", since a broken filter yields 0 too.
    // A mid-range score can only happen if real task ids matched.
    return (async () => {
      const corpusDir = await twoTaskCorpus();
      const runsDir = await mkdtemp(join(tmpdir(), "tsforge-progress-pair-"));
      let turn = 0;

      try {
        const out = await evaluateHarness(["pair"], {
          corpusDir,
          runsDir,
          // Solves task `one` on its first turn, then refuses to do anything
          // else — so task `one` greens and task `two` never resolves.
          provider: {
            complete: () => {
              turn += 1;

              return Promise.resolve(
                turn === 1
                  ? {
                      content: "",
                      toolCalls: [
                        {
                          id: "1",
                          name: "create",
                          arguments: {
                            file: "one.ts",
                            content:
                              "export function one() {\n  return 1;\n}\n",
                          },
                        },
                      ],
                    }
                  : { content: "I will not.", toolCalls: [] }
              );
            },
          },
          repeats: 1,
          overlay: null,
        });

        const progress = out.records[0]?.progress;

        expect(out.score.passed).toBe(0);
        expect(progress).toBeGreaterThan(0);
        expect(progress).toBeLessThan(1);
      } finally {
        await rm(corpusDir, { recursive: true, force: true });
        await rm(runsDir, { recursive: true, force: true });
      }
    })();
  }, 180_000);
});
