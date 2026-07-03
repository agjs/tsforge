import { test, expect } from "bun:test";
import { capabilityRows } from "../src/cli/capability-menu";
import { buildCapabilities } from "../src/cli/capabilities";
import { renderMenu } from "../src/render/owned-menu";

test("capabilityRows preserves group + label + describe for every capability", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const rows = capabilityRows(caps);

  expect(rows.length).toBe(caps.length);

  for (let i = 0; i < caps.length; i++) {
    expect(rows[i]?.group).toBe(caps[i]?.group);
    expect(rows[i]?.label).toBe(caps[i]?.label);
    expect(rows[i]?.describe).toBe(caps[i]?.describe);
  }
});

test("rendered browser shows all capability descriptions", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const screen = renderMenu(capabilityRows(caps), 0, false);

  for (const c of caps) {
    expect(screen).toContain(c.describe);
  }
});
