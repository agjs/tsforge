import { describe, expect, test } from "bun:test";
import { CONSOLE } from "../src/render/frame/chrome";
import {
  MENU_FOOTER_NAV,
  formatMenuRow,
  formatOverlayShell,
  menuBodyBudget,
  menuRule,
  menuWindow,
} from "../src/render/menu-chrome";
import { formatMenuRows } from "../src/render/inline-menu";
import { STYLE } from "../src/render/style";
import { stripSgr } from "../src/render/frame";

describe("menu-chrome", () => {
  test("formatMenuRow uses ▸ + CONSOLE.bright when active", () => {
    const row = formatMenuRow({
      label: "/copy",
      hint: "on",
      active: true,
      columns: 40,
      color: true,
    });

    expect(stripSgr(row)).toMatch(/^▸ /);
    expect(row).toContain(CONSOLE.bright);
    expect(row).not.toContain(STYLE.cyan);
  });

  test("formatMenuRow inactive paints CONSOLE.fg (no SGR inherit / no cyan)", () => {
    const row = formatMenuRow({
      label: "/clear",
      active: false,
      columns: 40,
      color: true,
    });

    expect(stripSgr(row)).toMatch(/^ {2}/);
    expect(row).toContain(CONSOLE.fg);
    expect(row).not.toContain(CONSOLE.bright);
    expect(row).not.toContain(CONSOLE.meta);
    expect(row).not.toContain(STYLE.cyan);
  });

  test("formatOverlayShell orders title, body, rule+describe, footer", () => {
    const lines = formatOverlayShell({
      title: "commands",
      bodyLines: ["  body"],
      describe: "does a thing",
      footer: MENU_FOOTER_NAV,
      columns: 40,
      color: false,
    });
    const plain = lines.map(stripSgr);

    expect(plain[0]).toBe("commands");
    expect(plain).toContain("  body");
    expect(plain.some((l) => l.includes("─"))).toBe(true);
    expect(plain).toContain("does a thing");
    expect(plain.at(-1)).toContain("↑/↓ move");
  });

  test("menuRule uses CONSOLE.rule", () => {
    const rule = menuRule(20, true);

    expect(rule).toContain(CONSOLE.rule);
    expect(stripSgr(rule)).toBe("─".repeat(20));
  });

  test("menuWindow keeps cursor visible", () => {
    expect(menuWindow(12, 9, 4)).toEqual({ start: 7, end: 11 });
    expect(menuWindow(3, 0, 8)).toEqual({ start: 0, end: 3 });
  });

  test("menuBodyBudget leaves room for chrome", () => {
    expect(menuBodyBudget(20, { hasDescribe: true })).toBeLessThan(20);
    expect(menuBodyBudget(20, { hasDescribe: true })).toBeGreaterThanOrEqual(1);
  });

  test("formatMenuRows fits a short overlay budget and keeps ▸ on cursor", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `r${String(i)}`,
      label: `Item ${String(i)}`,
      describe: `desc ${String(i)}`,
    }));
    const lines = formatMenuRows(rows, 10, 60, 12, false, "commands");
    const plain = lines.map(stripSgr).join("\n");

    expect(plain).toContain("commands");
    expect(plain).toContain("▸ Item 10");
    expect(plain).toContain("desc 10");
    expect(plain).toContain(MENU_FOOTER_NAV);
    // Must not dump the full list into a 12-row budget.
    expect(plain).not.toContain("Item 0");
  });
});
