import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { runTask } from "../src/loop";
import { scripted, editStep, STOP } from "./stub-provider";

// A one-chunk spec in our format: make a failing test pass.
const SPEC = `---
id: hello
title: Hello sum
verify: bun test
---

## Tasks
1. [logic] implement sum
     accept: bun test sum.test.ts
     files: sum.ts
`;

const TEST_FILE = `import { test, expect } from "bun:test";
import { sum } from "./sum";
test("sum adds", () => { expect(sum(2, 3)).toBe(5); });
`;

const BROKEN = `export function sum(_a: number, _b: number): number {
  throw new Error("not implemented");
}
`;

const FIXED = `export function sum(a: number, b: number): number {
  return a + b;
}
`;

test("walking skeleton drives a one-chunk spec from red to green", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-skeleton-"));

  try {
    // Build the tiny fixture project in an isolated temp dir.
    await Bun.write(join(dir, "sum.ts"), BROKEN);
    await Bun.write(join(dir, "sum.test.ts"), TEST_FILE);
    await Bun.write(join(dir, "spec.md"), SPEC);

    // Parse the spec from our format.
    const spec = parseSpec(SPEC);

    expect(spec.id).toBe("hello");
    expect(spec.tasks).toHaveLength(1);
    const task = spec.tasks[0]!;

    expect(task.accept).toBe("bun test sum.test.ts");
    expect(task.files).toEqual(["sum.ts"]);

    // The stubbed "model": edits the broken impl to the canned fix, then stops.
    const provider = scripted([editStep("sum.ts", BROKEN, FIXED), STOP]);
    const result = await runTask(task, dir, provider);

    expect(result.redConfirmed).toBe(true); // failed before the edit
    expect(result.status).toBe("done"); // passes after the edit
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
