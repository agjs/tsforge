import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allMustRun, evaluateHarness, meanProgress } from "../src/self-harness";
import { runShellCommand } from "../src/lib/fs/process";

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

/**
 * A TWO-task BROWNFIELD corpus that starts with real, countable gate errors.
 *
 * Brownfield (`mode: existing`) so `startRed` leaves the seeded files in place —
 * a scratch corpus deletes them, and in a temp dir with no tsconfig the gate is
 * eslint-only, so a missing file produces no diagnostic at all and the error
 * count never moves. Here `one.ts` ships with lint violations the model can
 * clear, while `two.ts` is lint-clean but returns the wrong value, so the run
 * reduces gate errors and still FAILS.
 */
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
      "mode: existing",
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
  }

  // Lint-dirty AND wrong: several padding-line violations for the gate to count.
  await writeFile(
    join(task, "one.ts"),
    [
      "export function one() {",
      "  const a = 0;",
      "  const b = a;",
      "  return b;",
      "}",
      "",
    ].join("\n")
  );
  // Lint-clean, but wrong — so the run cannot go green on task two.
  await writeFile(
    join(task, "two.ts"),
    "export function two() {\n  return 0;\n}\n"
  );

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

  test("the split aggregate is the mean of the recorded runs", () => {
    // What this level can honestly prove: progress is computed, lands on every
    // record, and reaches the split score the acceptance rule reads. The
    // GRADED SEMANTICS are covered in self-harness-progress.test.ts, not here —
    // a bare temp-dir fixture cannot produce a meaningful mid-range score,
    // because the repo-wide gate `gateSpec` prefixes to every task errors on
    // the scaffolding itself and never responds to what the model writes.
    // Asserting a mid-range value here would be asserting a fixture artefact.
    return (async () => {
      const corpusDir = await twoTaskCorpus();
      const runsDir = await mkdtemp(join(tmpdir(), "tsforge-progress-pair-"));
      let turn = 0;

      try {
        const out = await evaluateHarness(["pair"], {
          corpusDir,
          runsDir,
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
                          // `edit`, not `create`: brownfield leaves one.ts in
                          // place and create refuses to overwrite a file that
                          // still parses.
                          name: "edit",
                          arguments: {
                            file: "one.ts",
                            oldString:
                              "  const a = 0;\n  const b = a;\n  return b;",
                            newString: "  return 1;",
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

        const scores = out.records.map((r) => r.progress);

        expect(scores.every((v) => typeof v === "number")).toBe(true);
        expect(out.score.avgProgress).toBe(meanProgress(scores));

        // And the invariant a constant cannot satisfy: a PASSING run records
        // exactly 1, a failed one strictly less. `progress: 0` everywhere
        // satisfies both assertions above; it cannot satisfy this one.
        expect(out.runs).toHaveLength(out.records.length);

        for (const r of out.records) {
          if (r.passed) {
            expect(r.progress).toBe(1);
          } else {
            expect(r.progress).toBeGreaterThanOrEqual(0);
            expect(r.progress).toBeLessThan(1);
          }
        }

        // The wiring this pass exists to establish: the run FAILED (two.ts was
        // never written) but it did resolve real gate errors along the way —
        // startRed deleted both files, the model restored one. A hardcoded 0, or
        // an end reading that is just the start reading again, fails here and
        // passes every other assertion in this suite.
        const failed = out.records.filter((r) => !r.passed);

        expect(failed.length).toBeGreaterThan(0);

        for (const r of failed) {
          expect(r.progress).toBeGreaterThan(0);
        }
      } finally {
        await rm(corpusDir, { recursive: true, force: true });
        await rm(runsDir, { recursive: true, force: true });
      }
    })();
  }, 180_000);
});

describe("allMustRun", () => {
  /**
   * The graded score is two readings of the gate, so a reading has to be TOTAL
   * residual errors. The gate's own join is `&&`, fail-fast by design, which
   * makes a failing gate's count "whichever stage died first" — so 50 type
   * errors going to 3 type errors reads as 94% resolved while every lint error
   * behind it is still there. That clears the promotion floor by a mile, and no
   * other guard catches it: the same stage switch moves held-in and held-out
   * together, and fail-fast uses FEWER cycles so the blowup veto stays quiet.
   */
  const run = (parts: string[]): Promise<{ exitCode: number; out: string }> =>
    runShellCommand(process.cwd(), allMustRun(parts)).then((r) => ({
      exitCode: r.exitCode,
      out: r.stdout + r.stderr,
    }));

  test("exits 0 only when EVERY stage passes", async () => {
    expect((await run(["true", "true", "true"])).exitCode).toBe(0);
    expect((await run(["false", "true", "true"])).exitCode).not.toBe(0);
    expect((await run(["true", "false", "true"])).exitCode).not.toBe(0);
    expect((await run(["true", "true", "false"])).exitCode).not.toBe(0);
  });

  test("a failing FIRST stage does not hide what the later ones would report", async () => {
    // THE point. Under `&&` this output is TSC_ERR alone, and the reading is
    // "1 error" for a tree that also has every lint rule and every test failing.
    const r = await run([
      "echo TSC_ERR; false",
      "echo LINT_ERR; false",
      "echo TEST_ERR; false",
    ]);

    expect(r.out).toContain("TSC_ERR");
    expect(r.out).toContain("LINT_ERR");
    expect(r.out).toContain("TEST_ERR");
    expect(r.exitCode).not.toBe(0);
  });

  test("a stage calling `exit 0` cannot report success for the whole gate", async () => {
    // Stages are opaque strings built elsewhere. In a brace group an `exit`, a
    // `set -e`, or a trap escapes the wrapper; a subshell contains it.
    const r = await run(["echo A; exit 0", "echo B; false"]);

    expect(r.out).toContain("B");
    expect(r.exitCode).not.toBe(0);
  });

  test("a stage cannot poison the status variable of another", async () => {
    const r = await run(["__tsf_bad=0; false", "true"]);

    expect(r.exitCode).not.toBe(0);
  });

  test("no stages is vacuously green", async () => {
    expect((await run([])).exitCode).toBe(0);
  });
});
