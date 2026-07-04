import { test, expect } from "bun:test";
import { buildCapabilities } from "../src/cli/capabilities";
import { COMMANDS } from "../src/cli/commands";

const deps = { hasRecipes: true };

test("every capability has group, label, non-empty describe, valid kind", () => {
  for (const c of buildCapabilities(deps)) {
    expect(c.group.length).toBeGreaterThan(0);
    expect(c.label.length).toBeGreaterThan(0);
    expect(c.describe.length).toBeGreaterThan(0);
    expect(["command", "wizard"]).toContain(c.kind);
  }
});

test("command/wizard capabilities carry an invoke", () => {
  for (const c of buildCapabilities(deps)) {
    expect(c.invoke).toBeDefined();
  }
});

// ── the keystone: anti-drift ────────────────────────────────────────────────
test("ANTI-DRIFT: every slash command has a discovery home", () => {
  const caps = buildCapabilities(deps);
  const covered = new Set(
    caps
      .filter((c) => c.invoke?.type === "run" || c.invoke?.type === "prefill")
      .map((c) =>
        c.invoke?.type === "run" || c.invoke?.type === "prefill"
          ? c.invoke.command
          : ""
      )
  );
  // Commands intentionally excluded from the browser (they ARE the browser / trivial).
  const exempt = new Set(["/help", "/exit"]);

  for (const spec of COMMANDS) {
    if (exempt.has(spec.name)) {
      continue;
    }

    expect(covered.has(spec.name)).toBe(true);
  }
});

test("recipe row is present only when recipes exist", () => {
  expect(
    buildCapabilities({ hasRecipes: true }).some((c) => c.id === "recipe")
  ).toBe(true);
  expect(
    buildCapabilities({ hasRecipes: false }).some((c) => c.id === "recipe")
  ).toBe(false);
});
