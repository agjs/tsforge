import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRecipe,
  loadRecipes,
  findRecipe,
  unrecognizedKeys,
  invalidProfileValue,
} from "../src/config/recipes";

describe("parseRecipe", () => {
  test("accepts a well-formed recipe and keeps only valid fields", () => {
    const r = parseRecipe({
      id: "api-endpoint",
      description: "scaffold an API route",
      gate: "bun run validate",
      files: ["src/api/**", "  ", 42],
      model: "qwen3-coder",
      maxTurns: 30,
      thinkingBudget: 2048,
      policyMode: "default",
      web: true,
      bogusField: "ignored",
    });

    expect(r?.id).toBe("api-endpoint");
    expect(r?.gate).toBe("bun run validate");
    expect(r?.files).toEqual(["src/api/**"]); // blanks + non-strings dropped
    expect(r?.maxTurns).toBe(30);
    expect(r?.policyMode).toBe("default");
    expect(r?.web).toBe(true);
    expect("bogusField" in (r ?? {})).toBe(false);
  });

  test("parses the withReview flag and does not flag it as unrecognized", () => {
    const r = parseRecipe({ id: "repair-with-review", withReview: true });

    expect(r?.withReview).toBe(true);
    expect(unrecognizedKeys({ id: "x", withReview: true })).toEqual([]);
    // a non-boolean withReview is dropped, never coerced
    expect(
      parseRecipe({ id: "x", withReview: "yes" })?.withReview
    ).toBeUndefined();
  });

  test("parses the greenfield role models", () => {
    const r = parseRecipe({
      id: "build-app",
      mode: "greenfield",
      plannerModel: "big-thinker",
      workModel: "fast-coder",
      evaluatorModel: "harsh-judge",
    });

    expect(r?.plannerModel).toBe("big-thinker");
    expect(r?.workModel).toBe("fast-coder");
    expect(r?.evaluatorModel).toBe("harsh-judge");
    expect(
      unrecognizedKeys({
        id: "x",
        plannerModel: "a",
        workModel: "b",
        evaluatorModel: "c",
      })
    ).toEqual([]);
  });

  test("accepts mode:greenfield and drops any other mode value", () => {
    expect(parseRecipe({ id: "build-app", mode: "greenfield" })?.mode).toBe(
      "greenfield"
    );
    expect(parseRecipe({ id: "x", mode: "spaceship" })?.mode).toBeUndefined();
    expect(unrecognizedKeys({ id: "x", mode: "greenfield" })).toEqual([]);
  });

  test("rejects a recipe with no id or a non-kebab id", () => {
    expect(parseRecipe({ gate: "x" })).toBeNull();
    expect(parseRecipe({ id: "Has Spaces" })).toBeNull();
    expect(parseRecipe({ id: "UPPER" })).toBeNull();
    expect(parseRecipe("not an object")).toBeNull();
  });

  test("drops an invalid policyMode and a non-positive maxTurns", () => {
    const r = parseRecipe({ id: "x", policyMode: "yolo", maxTurns: 0 });

    expect(r?.policyMode).toBeUndefined();
    expect(r?.maxTurns).toBeUndefined();
  });

  test("a whitespace-only string field becomes undefined (not a broken value)", () => {
    const r = parseRecipe({ id: "x", gate: "   ", model: "\t", base: "\n" });

    expect(r?.gate).toBeUndefined();
    expect(r?.model).toBeUndefined();
    expect(r?.base).toBeUndefined();
    // and a real value is trimmed
    expect(parseRecipe({ id: "x", gate: "  bun test  " })?.gate).toBe(
      "bun test"
    );
  });

  test("flags fields it doesn't yet apply (so they don't silently vanish)", () => {
    // `tools` isn't applied in v1 — surface it rather than ignore.
    expect(unrecognizedKeys({ id: "x", tools: ["read"] })).toEqual(["tools"]);
    expect(unrecognizedKeys({ id: "x", profile: "strict" })).toEqual([]);
    expect(unrecognizedKeys({ id: "x", gate: "g" })).toEqual([]);
  });

  test("parses a valid profile and drops an invalid one", () => {
    expect(parseRecipe({ id: "strict-run", profile: "strict" })?.profile).toBe(
      "strict"
    );
    expect(parseRecipe({ id: "x", profile: "yolo" })?.profile).toBeUndefined();
  });

  test("an invalid profile value is surfaced, a valid or absent one is not", () => {
    expect(invalidProfileValue({ id: "x", profile: "strictt" })).toBe(
      "strictt"
    );
    expect(invalidProfileValue({ id: "x", profile: "strict" })).toBeUndefined();
    expect(invalidProfileValue({ id: "x" })).toBeUndefined();
    // a non-string profile is a shape problem, not a typo'd id — not surfaced here
    expect(invalidProfileValue({ id: "x", profile: 3 })).toBeUndefined();
  });
});

describe("loadRecipes", () => {
  test("discovers project recipes and overrides global on id collision", async () => {
    const home = await mkdtemp(join(tmpdir(), "tsforge-rec-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "tsforge-rec-proj-"));
    const prev = process.env.TSFORGE_HOME;

    try {
      process.env.TSFORGE_HOME = home;
      await mkdir(join(home, ".tsforge", "recipes"), { recursive: true });
      await mkdir(join(cwd, ".tsforge", "recipes"), { recursive: true });

      // global: two recipes
      await writeFile(
        join(home, ".tsforge/recipes/shared.json"),
        JSON.stringify({ id: "shared", gate: "global-gate" })
      );
      await writeFile(
        join(home, ".tsforge/recipes/global-only.json"),
        JSON.stringify({ id: "global-only", gate: "g" })
      );
      // project overrides `shared`, adds `proj-only`, and one broken file
      await writeFile(
        join(cwd, ".tsforge/recipes/shared.json"),
        JSON.stringify({ id: "shared", gate: "project-gate" })
      );
      await writeFile(
        join(cwd, ".tsforge/recipes/proj-only.json"),
        JSON.stringify({ id: "proj-only", gate: "p" })
      );
      // id ≠ filename: registers under its declared id but warns about the mismatch.
      await writeFile(
        join(cwd, ".tsforge/recipes/mismatch.json"),
        JSON.stringify({ id: "not-mismatch", gate: "g" })
      );
      await writeFile(join(cwd, ".tsforge/recipes/broken.json"), "{ not json");
      // typo'd profile: loads, but must warn instead of silently downgrading
      await writeFile(
        join(cwd, ".tsforge/recipes/typo-profile.json"),
        JSON.stringify({ id: "typo-profile", profile: "strictt" })
      );

      const reports: string[] = [];
      const recipes = await loadRecipes(cwd, (m) => reports.push(m));

      expect(recipes.map((r) => r.id)).toEqual([
        "global-only",
        "not-mismatch",
        "proj-only",
        "shared",
        "typo-profile",
      ]);
      expect(findRecipe(recipes, "shared")?.gate).toBe("project-gate"); // project wins
      expect(reports.some((m) => m.includes("broken.json"))).toBe(true);
      expect(
        reports.some(
          (m) => m.includes("mismatch.json") && m.includes("not-mismatch")
        )
      ).toBe(true);
      expect(
        reports.some(
          (m) => m.includes("invalid profile 'strictt'") && m.includes("valid:")
        )
      ).toBe(true);
      // the valid-profile recipes above must not trigger the warning
      expect(reports.filter((m) => m.includes("invalid profile")).length).toBe(
        1
      );
    } finally {
      if (prev === undefined) {
        delete process.env.TSFORGE_HOME;
      } else {
        process.env.TSFORGE_HOME = prev;
      }

      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a repo with no recipe dirs yields an empty list (no throw)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tsforge-rec-empty-"));
    const prev = process.env.TSFORGE_HOME;

    try {
      process.env.TSFORGE_HOME = cwd; // also empty
      expect(await loadRecipes(cwd)).toEqual([]);
    } finally {
      if (prev === undefined) {
        delete process.env.TSFORGE_HOME;
      } else {
        process.env.TSFORGE_HOME = prev;
      }

      await rm(cwd, { recursive: true, force: true });
    }
  });
});
