import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solutionFiles, guardQuality } from "../src/self-harness";
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
      const files = await solutionFiles(dir, {
        tasks: [{ files: ["a.ts"] }, { files: ["src/b.ts"] }],
      });

      expect(files.sort()).toEqual(["a.ts", "src/b.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands globs, because ITask.files holds patterns not paths", async () => {
    const dir = await corpus();

    try {
      const files = await solutionFiles(dir, {
        tasks: [{ files: ["src/**/*.ts"] }],
      });

      expect(files.sort()).toEqual(["src/b.ts", "src/deep/c.ts"]);
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
      const files = await solutionFiles(dir, {
        tasks: [{ files: ["src/**/*.ts"] }, { files: ["src/b.ts"] }],
      });

      expect(files.filter((f) => f === "src/b.ts")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pattern matching nothing contributes nothing, and does not throw", async () => {
    const dir = await corpus();

    try {
      expect(
        await solutionFiles(dir, { tasks: [{ files: ["nope/*.ts"] }] })
      ).toEqual([]);
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

  test("an unreachable endpoint stays UNMEASURED", () => {
    // The line that keeps flooring fair: a dead endpoint is nobody's doing, and
    // the mechanical gate is the real oracle regardless.
    expect(guardQuality(score("unreachable"))).toBeUndefined();
  });
});
