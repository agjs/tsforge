import { test, expect } from "bun:test";
import { archetypeStep } from "../src/cli/repl-scaffold";

test("archetype step offers boringstack, astro, vite", () => {
  const step = archetypeStep();

  expect(step.kind).toBe("single");

  const values = step.options.map((o) => o.value);

  expect(values).toEqual(["boringstack", "astro", "vite"]);
});
