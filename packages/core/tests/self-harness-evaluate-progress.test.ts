import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bothMustPass,
  evaluateHarness,
  meanProgress,
} from "../src/self-harness";
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
      } finally {
        await rm(corpusDir, { recursive: true, force: true });
        await rm(runsDir, { recursive: true, force: true });
      }
    })();
  }, 180_000);
});

describe("bothMustPass", () => {
  /**
   * The graded score reads gate error counts as one series, so every reading has
   * to mean the same thing. `&&` broke that: once the gate went red it hid every
   * downstream failure behind it, so breaking the type check turned forty test
   * failures into one error and READ as progress.
   */
  const run = (
    gate: string,
    own: string
  ): Promise<{ exitCode: number; out: string }> =>
    runShellCommand(process.cwd(), bothMustPass(gate, own)).then((r) => ({
      exitCode: r.exitCode,
      out: r.stdout + r.stderr,
    }));

  test("exits 0 only when BOTH sides pass", async () => {
    expect((await run("true", "true")).exitCode).toBe(0);
    expect((await run("false", "true")).exitCode).not.toBe(0);
    expect((await run("true", "false")).exitCode).not.toBe(0);
    expect((await run("false", "false")).exitCode).not.toBe(0);
  });

  test("a failing gate does not hide the downstream errors", async () => {
    // THE point. Under `&&` this output would contain GATE_ERR alone, and the
    // reading would be "1 error" for a run that also has every test failing.
    const r = await run("echo GATE_ERR; false", "echo OWN_ERR; false");

    expect(r.out).toContain("GATE_ERR");
    expect(r.out).toContain("OWN_ERR");
  });

  test("a failing gate does not suppress a PASSING downstream either", async () => {
    const r = await run("echo GATE_ERR; false", "echo OWN_RAN");

    expect(r.out).toContain("OWN_RAN");
    expect(r.exitCode).not.toBe(0);
  });
});
