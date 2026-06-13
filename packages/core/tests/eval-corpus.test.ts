import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

async function seedNames(): Promise<string[]> {
  const entries = await readdir(CORPUS, { withFileTypes: true });

  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

test("every committed corpus seed parses into a runnable spec", async () => {
  const seeds = await seedNames();

  expect(seeds.length).toBeGreaterThan(0);

  for (const seed of seeds) {
    const text = await Bun.file(join(CORPUS, seed, `${seed}.spec.md`)).text();
    const spec = parseSpec(text);

    expect(spec.id).toBe(seed);
    expect(spec.verify.length).toBeGreaterThan(0);
    expect(spec.tasks.length).toBeGreaterThan(0);

    for (const task of spec.tasks) {
      expect(task.accept.length).toBeGreaterThan(0);
      expect(task.files.length).toBeGreaterThan(0);
    }
  }
});

test("every corpus task's editable + context files exist on disk", async () => {
  for (const seed of await seedNames()) {
    const text = await Bun.file(join(CORPUS, seed, `${seed}.spec.md`)).text();
    const spec = parseSpec(text);

    for (const task of spec.tasks) {
      for (const file of [...task.files, ...(task.context ?? [])]) {
        const exists = await Bun.file(join(CORPUS, seed, file)).exists();

        expect(exists).toBe(true);
      }
    }
  }
});
