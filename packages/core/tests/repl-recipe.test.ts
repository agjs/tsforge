import { test, expect } from "bun:test";
import { recipeRows } from "../src/cli/repl-recipe";

test("recipeRows renders id as label + description (or a fallback) as describe", () => {
  const rows = recipeRows([
    { id: "ship-fix", description: "fix to green then review" },
    { id: "bare" },
  ]);

  expect(rows[0]).toEqual({
    id: "ship-fix",
    label: "ship-fix",
    describe: "fix to green then review",
  });
  expect(rows[1]?.describe.length).toBeGreaterThan(0); // fallback, never empty
});
