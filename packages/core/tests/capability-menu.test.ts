import { test, expect } from "bun:test";
import { capabilityRows } from "../src/cli/capability-menu";
import { buildCapabilities } from "../src/cli/capabilities";
import { formatMenuRows } from "../src/render/inline-menu";

test("capabilityRows preserves label + describe for every capability", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const rows = capabilityRows(caps);

  expect(rows.length).toBe(caps.length);

  for (let i = 0; i < caps.length; i++) {
    expect(rows[i]?.label).toBe(caps[i]?.label);
    expect(rows[i]?.describe).toBe(caps[i]?.describe);
  }
});

test("formatted menu shows selected row's describe", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const rows = capabilityRows(caps);

  if (rows.length > 0) {
    const screen = formatMenuRows(rows, 0, 80, 44, false, "help");

    expect(screen.join("\n")).toContain(rows[0]?.describe ?? "");
  }
});
