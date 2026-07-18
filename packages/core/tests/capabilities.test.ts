import { test, expect } from "bun:test";
import {
  buildCapabilities,
  COMMAND_WIZARD_HOME,
} from "../src/cli/capabilities";
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
  // A command whose home is a wizard row is covered iff that wizard capability exists.
  const wizardOpeners = new Set(
    caps
      .filter((c) => c.invoke?.type === "wizard")
      .map((c) => (c.invoke?.type === "wizard" ? c.invoke.opener : ""))
  );
  // Commands intentionally excluded from the browser (they ARE the browser / trivial).
  const exempt = new Set(["/help", "/exit"]);

  for (const spec of COMMANDS) {
    if (exempt.has(spec.name)) {
      continue;
    }

    const wizardHome = COMMAND_WIZARD_HOME[spec.name];
    const hasHome =
      covered.has(spec.name) ||
      (wizardHome !== undefined && wizardOpeners.has(wizardHome));

    expect(hasHome).toBe(true);
  }
});

test("ANTI-DRIFT: /scaffold has a WIZARD home, never a fire-and-forget command row", () => {
  const caps = buildCapabilities(deps);

  // No generated command row for /scaffold (that path uses `void runLine` from the
  // browser, which races the wizard for stdin). Its home is the scaffold wizard row.
  const runRows = caps.filter(
    (c) =>
      (c.invoke?.type === "run" || c.invoke?.type === "prefill") &&
      c.invoke.command === "/scaffold"
  );

  expect(runRows).toHaveLength(0);
  expect(
    caps.some(
      (c) => c.invoke?.type === "wizard" && c.invoke.opener === "scaffold"
    )
  ).toBe(true);
});

test("recipe row is present only when recipes exist", () => {
  expect(
    buildCapabilities({ hasRecipes: true }).some((c) => c.id === "recipe")
  ).toBe(true);
  expect(
    buildCapabilities({ hasRecipes: false }).some((c) => c.id === "recipe")
  ).toBe(false);
});
