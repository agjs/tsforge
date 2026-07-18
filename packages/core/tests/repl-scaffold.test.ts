import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archetypeStep,
  resolveScaffoldDest,
  scaffoldFromAnswers,
} from "../src/cli/repl-scaffold";
import {
  loadBundledManifest,
  type runScaffold,
  type IScaffoldOutcome,
} from "../src/scaffold";

const STUB_OUTCOME: IScaffoldOutcome = {
  dir: "/tmp/proj",
  gateCwd: "/tmp/proj",
  gateCommand: "bun run validate",
  resolvedSha: "abc123",
  booted: true,
  summary: ["STACK=dev"],
  ports: {},
};

test("scaffoldFromAnswers forwards clone progress to out and prints the handoff", async () => {
  const out: string[] = [];

  // A fake runner that fires a progress phase and returns a stub outcome — no real
  // clone/boot. Proves openScaffoldInRepl's run+progress+handoff wiring end to end.
  const fakeRun: typeof runScaffold = (_manifest, _answers, _dest, deps) => {
    deps.onPhase?.("Cloning the project template…");

    return Promise.resolve(STUB_OUTCOME);
  };

  await scaffoldFromAnswers(
    loadBundledManifest(),
    { archetype: "boringstack", stack: "dev", values: {} },
    "/tmp/proj",
    (s) => out.push(s),
    fakeRun
  );

  const joined = out.join("");

  // Progress reached the sink in the standard "  → …" format...
  expect(joined).toContain("  → Cloning the project template…\n");
  // ...the handoff printed...
  expect(joined).toContain("scaffold ready → /tmp/proj");
  // ...and the boringstack planning note followed.
  expect(joined).toContain("run planning when you submit");
});

test("archetype step offers boringstack, astro", () => {
  const step = archetypeStep();

  expect(step.kind).toBe("single");

  const values = step.options.map((o) => o.value);

  expect(values).toEqual(["boringstack", "astro"]);
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
