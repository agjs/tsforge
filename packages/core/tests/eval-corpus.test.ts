import { test, expect } from "bun:test";
import { join } from "node:path";
import { parseSpec } from "../src/spec";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

test("the math corpus seed parses into a runnable spec", async () => {
  const text = await Bun.file(join(CORPUS, "math", "math.spec.md")).text();
  const spec = parseSpec(text);

  expect(spec.id).toBe("math");
  expect(spec.verify).toBe("bun test");
  expect(spec.tasks.map((t) => t.id)).toEqual(["1", "2"]);

  for (const task of spec.tasks) {
    expect(task.accept.length).toBeGreaterThan(0);
    expect(task.files.length).toBeGreaterThan(0);
  }
});

test("each math corpus task's editable + context files exist on disk", async () => {
  const text = await Bun.file(join(CORPUS, "math", "math.spec.md")).text();
  const spec = parseSpec(text);

  for (const task of spec.tasks) {
    for (const file of [...task.files, ...(task.context ?? [])]) {
      const exists = await Bun.file(join(CORPUS, "math", file)).exists();

      expect(exists).toBe(true);
    }
  }
});
