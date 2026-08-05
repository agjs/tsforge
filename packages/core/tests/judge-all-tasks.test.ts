import { test, expect, describe } from "bun:test";
import { solutionFiles } from "../src/self-harness";

/**
 * The judge read `spec.tasks[0]` only, so on a multi-task spec it scored the
 * first task's files while `countTaskLoc` beside it measured EVERY task's —
 * quality and size were describing different artifacts, and most of what the
 * model wrote was never looked at.
 */

describe("solutionFiles", () => {
  test("collects EVERY task's files, not just the first", () => {
    expect(
      solutionFiles({
        tasks: [{ files: ["one.ts"] }, { files: ["two.ts", "three.ts"] }],
      })
    ).toEqual(["one.ts", "two.ts", "three.ts"]);
  });

  test("dedupes a file two tasks both name", () => {
    // Two tasks may legitimately edit the same file. Sending it twice wastes
    // budget and shows the judge a doubled artifact.
    expect(
      solutionFiles({
        tasks: [{ files: ["shared.ts"] }, { files: ["shared.ts", "b.ts"] }],
      })
    ).toEqual(["shared.ts", "b.ts"]);
  });

  test("a single-task spec is unchanged", () => {
    expect(solutionFiles({ tasks: [{ files: ["only.ts"] }] })).toEqual([
      "only.ts",
    ]);
  });

  test("a spec with no tasks yields nothing", () => {
    expect(solutionFiles({ tasks: [] })).toEqual([]);
  });
});
