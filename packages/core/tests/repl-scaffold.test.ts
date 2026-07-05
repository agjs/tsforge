import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archetypeStep, resolveScaffoldDest } from "../src/cli/repl-scaffold";

test("archetype step offers boringstack, astro, vite", () => {
  const step = archetypeStep();

  expect(step.kind).toBe("single");

  const values = step.options.map((o) => o.value);

  expect(values).toEqual(["boringstack", "astro", "vite"]);
});

test("resolveScaffoldDest: a plain name resolves under cwd (NOT a throwaway temp)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sc-cwd-"));
  const r = resolveScaffoldDest(cwd, "  my-app  ");

  expect("dest" in r && r.dest).toBe(join(cwd, "my-app"));
});

test("resolveScaffoldDest: rejects empty, path separators, and traversal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sc-cwd-"));

  for (const bad of ["", "   ", "a/b", "a\\b", "../evil", "..", "sub/../x"]) {
    const r = resolveScaffoldDest(cwd, bad);

    expect("error" in r).toBe(true);
  }
});

test("resolveScaffoldDest: refuses to overwrite an existing directory", () => {
  // cwd itself exists; a name equal to an existing entry must be rejected.
  const parent = mkdtempSync(join(tmpdir(), "sc-parent-"));
  const existing = mkdtempSync(join(parent, "app-")); // a real dir under parent
  const name = existing.slice(parent.length + 1);
  const r = resolveScaffoldDest(parent, name);

  expect("error" in r && r.error).toContain("already exists");
});
