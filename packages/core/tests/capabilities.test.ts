import { test, expect } from "bun:test";
import { buildCapabilities } from "../src/cli/capabilities";
import { COMMANDS } from "../src/cli/commands";
import { TOOL_NAME } from "../src/agent";

const deps = { hasRecipes: true };

test("every capability has group, label, non-empty describe, valid kind", () => {
  for (const c of buildCapabilities(deps)) {
    expect(c.group.length).toBeGreaterThan(0);
    expect(c.label.length).toBeGreaterThan(0);
    expect(c.describe.length).toBeGreaterThan(0);
    expect(["command", "wizard", "passive"]).toContain(c.kind);
  }
});

test("command/wizard capabilities carry an invoke; passive carry detail", () => {
  for (const c of buildCapabilities(deps)) {
    if (c.kind === "passive") {
      expect((c.detail ?? "").length).toBeGreaterThan(0);
    } else {
      expect(c.invoke).toBeDefined();
    }
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

test("ANTI-DRIFT: every model tool has a discovery home", () => {
  const passiveIds = new Set(
    buildCapabilities(deps)
      .filter((c) => c.kind === "passive")
      .map((c) => c.id)
  );
  // Tools surfaced as their own capability id `tool.<name>`. Scaffolders/core
  // edit tools are represented by the "Build"/"Core" rows, so exempt them.
  const exempt = new Set([
    "read",
    "run",
    "edit",
    "create",
    "edit_lines",
    "scaffold_web",
    "scaffold_ui",
    "scaffold_routes",
    "add_dependency",
  ]);

  for (const tool of Object.values(TOOL_NAME)) {
    if (exempt.has(tool)) {
      continue;
    }

    expect(passiveIds.has(`tool.${tool}`)).toBe(true);
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
