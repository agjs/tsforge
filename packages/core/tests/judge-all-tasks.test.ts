import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  solutionFiles,
  guardQuality,
  solutionFitsJudge,
  scoreSolution,
  MAX_SOLUTION_FILES,
} from "../src/self-harness";
import type { IProvider } from "../src/inference";
import { withinBudget, JUDGE_BUDGET } from "../src/eval";
import type { IJudgeScore } from "../src/eval";

/**
 * Two bugs in one place. The judge read `spec.tasks[0]` only, so on a multi-task
 * spec it scored the first task's files while `countTaskLoc` beside it measured
 * EVERY task's — quality and size describing different artifacts. And it read
 * `files` as literal paths, though they are scope GLOBS, which countTaskLoc
 * expands: a spec scoped to `src/**` reviewed nothing at all.
 */

async function corpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-solfiles-"));

  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(dir, "src", "deep", "c.ts"), "export const c = 3;\n");

  return dir;
}

describe("solutionFiles", () => {
  test("collects EVERY task's files, not just the first", async () => {
    const dir = await corpus();

    try {
      const scope = await solutionFiles(dir, {
        tasks: [{ files: ["a.ts"] }, { files: ["src/b.ts"] }],
      });

      expect(scope.files.sort()).toEqual(["a.ts", "src/b.ts"]);
      expect(scope.complete).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands globs, because ITask.files holds patterns not paths", async () => {
    const dir = await corpus();

    try {
      const scope = await solutionFiles(dir, {
        tasks: [{ files: ["src/**/*.ts"] }],
      });

      expect(scope.files.sort()).toEqual(["src/b.ts", "src/deep/c.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dedupes a file two tasks both match", async () => {
    // Two tasks may legitimately edit the same file, and overlapping globs make
    // it likelier. Sending it twice wastes budget and shows the judge a doubled
    // artifact.
    const dir = await corpus();

    try {
      const scope = await solutionFiles(dir, {
        tasks: [{ files: ["src/**/*.ts"] }, { files: ["src/b.ts"] }],
      });

      expect(scope.files.filter((f) => f === "src/b.ts")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pattern matching nothing contributes nothing, and does not throw", async () => {
    const dir = await corpus();

    try {
      const scope = await solutionFiles(dir, {
        tasks: [{ files: ["nope/*.ts"] }],
      });

      expect(scope.files).toEqual([]);
      expect(scope.complete).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("guardQuality", () => {
  /**
   * The security decision itself: which judge outcomes the acceptance guard
   * FLOORS and which it lets through unmeasured. Unmeasured means the guard is
   * skipped, which is a pass — so anything the candidate could have provoked has
   * to carry a number.
   */
  const score = (
    outcome: IJudgeScore["outcome"],
    overall = 4
  ): IJudgeScore => ({
    overall,
    correctness: overall,
    design: overall,
    readability: overall,
    notes: "",
    scored: outcome === "scored",
    outcome,
  });

  test("a real verdict passes its score through", () => {
    expect(guardQuality(score("scored", 3))).toBe(3);
  });

  test("an unusable answer is FLOORED, not skipped", () => {
    // Candidate code is in the judge's prompt and can ask for prose. Returning
    // undefined here skips the guard entirely — the bypass this exists to close.
    expect(guardQuality(score("unusable"))).toBe(1);
  });

  test("an oversized solution is FLOORED, not skipped", () => {
    expect(guardQuality(score("oversized"))).toBe(1);
  });

  test("an empty scope is FLOORED — it is the candidate's doing too", () => {
    // Covered indirectly through scoreSolution, but not in the table itself: a
    // "simplified" catch-all that mapped empty to undefined would skip the guard
    // and leave the table green.
    expect(guardQuality(score("empty"))).toBe(1);
  });

  test("an unreachable endpoint stays UNMEASURED", () => {
    // The line that keeps flooring fair: a dead endpoint is nobody's doing, and
    // the mechanical gate is the real oracle regardless.
    expect(guardQuality(score("unreachable"))).toBeUndefined();
  });
});

describe("solutionFitsJudge", () => {
  /**
   * The pre-read short-circuit: decide from file SIZES, so an artifact too big
   * to review is never materialised twice just to conclude that. It must use the
   * JUDGE's own arithmetic — a second threshold drifts, and then either refuses
   * what the judge accepts or reads what it would refuse.
   */
  test("a normal solution fits", async () => {
    const dir = await corpus();

    try {
      expect(solutionFitsJudge(dir, ["a.ts"], "goal", "criteria")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a solution past the code budget does not", async () => {
    const dir = await corpus();

    try {
      await writeFile(join(dir, "big.ts"), "x".repeat(JUDGE_BUDGET.code + 1));

      expect(solutionFitsJudge(dir, ["big.ts"], "goal", "criteria")).toBe(
        false
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("files that each fit but together do not are refused", async () => {
    // Summed, not checked one by one — otherwise a solution split across files
    // walks straight past the ceiling.
    const dir = await corpus();
    const half = Math.floor(JUDGE_BUDGET.code / 2) + 1;

    try {
      await writeFile(join(dir, "h1.ts"), "x".repeat(half));
      await writeFile(join(dir, "h2.ts"), "x".repeat(half));

      expect(solutionFitsJudge(dir, ["h1.ts"], "goal", "criteria")).toBe(true);
      expect(
        solutionFitsJudge(dir, ["h1.ts", "h2.ts"], "goal", "criteria")
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it agrees with the judge's own check on the same bytes", async () => {
    // The anti-drift assertion: same content, same verdict, from sizes as from
    // strings.
    const dir = await corpus();
    const code = "x".repeat(JUDGE_BUDGET.code + 1);

    try {
      await writeFile(join(dir, "big.ts"), code);

      expect(solutionFitsJudge(dir, ["big.ts"], "g", "c")).toBe(
        withinBudget({ goal: "g", criteria: "c", code })
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scoreSolution — the composed refusal path", () => {
  /**
   * The end-to-end assertion the isolated helpers cannot make. Each piece was
   * covered separately — globbing can return [], oversized floors — while the
   * branch that JOINS them was not, so swapping the empty-scope refusal for a
   * skip would leave every other test green and hand back the free pass this
   * round exists to close.
   */
  const neverCalled: IProvider = {
    complete: () => {
      throw new Error("the judge must not be called with an empty scope");
    },
  };

  test("an empty scope is refused with a FLOOR the guard can read", async () => {
    const dir = await corpus();

    try {
      const score = await scoreSolution(
        neverCalled,
        dir,
        { files: [], complete: true },
        "g",
        "c"
      );

      // Not "unreachable" and not absent: either would make heldOutGuards treat
      // avgQuality as unsignaled and skip the quality comparison entirely.
      expect(score.outcome).toBe("empty");
      expect(guardQuality(score)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty scope is a DIFFERENT refusal from oversized", async () => {
    // Nothing is over budget here; there is no artifact at all. Reusing the
    // oversized value works only because guardQuality floors every
    // candidate-side outcome — a trap for the next edit.
    const dir = await corpus();

    try {
      const empty = await scoreSolution(
        neverCalled,
        dir,
        { files: [], complete: true },
        "g",
        "c"
      );

      expect(empty.notes).toContain("no files in scope");
      expect(empty.outcome).not.toBe("oversized");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an oversized solution never reaches the judge", async () => {
    const dir = await corpus();

    try {
      await writeFile(join(dir, "big.ts"), "x".repeat(JUDGE_BUDGET.code + 1));

      const score = await scoreSolution(
        neverCalled,
        dir,
        { files: ["big.ts"], complete: true },
        "g",
        "c"
      );

      expect(score.outcome).toBe("oversized");
      expect(guardQuality(score)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a normal solution DOES reach the judge", async () => {
    // The other half: refusing everything would also pass the assertions above.
    const dir = await corpus();
    let called = 0;
    const provider: IProvider = {
      complete: () => {
        called += 1;

        return Promise.resolve({
          content: JSON.stringify({
            overall: 4,
            correctness: 4,
            design: 4,
            readability: 4,
            notes: "ok",
          }),
          toolCalls: [],
        });
      },
    };

    try {
      const score = await scoreSolution(
        provider,
        dir,
        { files: ["a.ts"], complete: true },
        "g",
        "c"
      );

      expect(called).toBe(1);
      expect(score.outcome).toBe("scored");
      expect(guardQuality(score)).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an incomplete scope is refused, not reviewed as if it were whole", () => {
  /**
   * The coupling that used to be implicit. Enumeration stopping and the caller
   * refusing were two comparisons against the same constant, and they had to
   * agree forever: flip one to `>=` while the other reads `>` and a 2000-file
   * prefix of a larger tree gets reviewed as though it were the entire solution.
   * `complete` is reported by the enumerator now, so there is nothing to infer.
   */
  const neverCalled: IProvider = {
    complete: () => {
      throw new Error("an incomplete scope must not reach the judge");
    },
  };

  test("enumeration reports itself incomplete at the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-manyfiles-"));

    try {
      await Promise.all(
        Array.from({ length: MAX_SOLUTION_FILES + 50 }, (_unused, i) =>
          writeFile(join(dir, `f${String(i)}.ts`), "export const x = 1;\n")
        )
      );

      const scope = await solutionFiles(dir, { tasks: [{ files: ["*.ts"] }] });

      expect(scope.complete).toBe(false);
      expect(scope.files.length).toBeLessThanOrEqual(MAX_SOLUTION_FILES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("and the caller refuses it at the floor, without reading", async () => {
    const dir = await corpus();

    try {
      const score = await scoreSolution(
        neverCalled,
        dir,
        { files: ["a.ts"], complete: false },
        "g",
        "c"
      );

      expect(score.outcome).toBe("oversized");
      expect(guardQuality(score)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
