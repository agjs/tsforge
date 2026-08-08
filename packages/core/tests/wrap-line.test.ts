import { test, expect, describe } from "bun:test";
import { wrapAnsiLine, wrapAnsiLines } from "../src/render/frame/wrap-line";
import { stripSgr } from "../src/render/frame/ansi-plain";

describe("wrapAnsiLine", () => {
  test("short line stays one row and keeps SGR", () => {
    const red = "\x1b[31mhi\x1b[0m";

    expect(wrapAnsiLine(red, 10)).toEqual([red]);
  });

  test("long plain line hard-splits when there are no spaces", () => {
    expect(wrapAnsiLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("overflow drops SGR and wraps plain text", () => {
    const red = "\x1b[31mabcdefgh\x1b[0m";

    expect(wrapAnsiLine(red, 3)).toEqual(["abc", "def", "gh"]);
  });

  test("prefers wrapping at spaces", () => {
    expect(wrapAnsiLine("hello wonderful world", 12)).toEqual([
      "hello",
      "wonderful",
      "world",
    ]);
  });

  test("re-emits │ rail on every continuation row", () => {
    const rows = wrapAnsiLine("│ hello wonderful world", 14);

    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows) {
      expect(row.startsWith("│ ")).toBe(true);
    }

    expect(rows.join("\n")).not.toContain("wond\n│ erful");
  });

  test("closed agent rows keep both rails when reflowing", () => {
    const row = `│ hello wonderful world${" ".repeat(3)}│`;
    const rows = wrapAnsiLine(row, 16);

    expect(rows.length).toBeGreaterThan(1);

    for (const r of rows) {
      const plain = stripSgr(r);

      expect(plain.startsWith("│")).toBe(true);
      expect(plain.endsWith("│")).toBe(true);
    }
  });

  test("reflowed boxed rails keep chrome SGR (right │ matches card color)", () => {
    const chrome = "\x1b[38;2;82;82;91m";
    const reset = "\x1b[0m";
    const left = `${chrome}│${reset}  `;
    const right = `${chrome}│${reset}`;
    const body = "hello wonderful world that wraps";
    const row = `${left}${body}${" ".repeat(2)}${right}`;
    const rows = wrapAnsiLine(row, 20);

    expect(rows.length).toBeGreaterThan(1);

    for (const r of rows) {
      expect(r.endsWith(`${chrome}│${reset}`)).toBe(true);
      expect(r.startsWith(`${chrome}│${reset}`)).toBe(true);
    }
  });

  test("reflowed cyan boxed rails keep cyan SGR", () => {
    const cyan = "\x1b[38;2;34;211;238m";
    const reset = "\x1b[0m";
    const left = `${cyan}│${reset}  `;
    const right = `${cyan}│${reset}`;
    const row = `${left}hello wonderful world${" ".repeat(2)}${right}`;
    const rows = wrapAnsiLine(row, 18);

    expect(rows.length).toBeGreaterThan(1);

    for (const r of rows) {
      expect(r).toContain(cyan);
      expect(r.endsWith(`${cyan}│${reset}`)).toBe(true);
    }
  });

  test("empty boxed rows that fit are resealed into one SGR span", () => {
    const chrome = "\x1b[38;2;82;82;91m";
    const reset = "\x1b[0m";
    // Split-rail blank (the iTerm dark-right-rail shape).
    const split =
      `${chrome}│${reset}` + " ".repeat(18) + `${chrome}│${reset}`;
    const [row] = wrapAnsiLine(split, 20);
    const first = row!.indexOf("│");
    const last = row!.lastIndexOf("│");

    expect(stripSgr(row!).length).toBe(20);
    expect(row!.slice(first + 1, last).includes(reset)).toBe(false);
    expect(row!.startsWith(chrome)).toBe(true);
  });

  test("fitting content rows reseal rails but keep body SGR", () => {
    const chrome = "\x1b[38;2;82;82;91m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const row = `${chrome}│${reset}  ${dim}hi${reset}              ${chrome}│${reset}`;
    const [out] = wrapAnsiLine(row, 20);

    expect(out).toContain(`${dim}hi`);
    expect(out!.startsWith(chrome)).toBe(true);
    expect(out!.endsWith(`${chrome}│${reset}`)).toBe(true);
    expect(stripSgr(out!).length).toBe(20);
  });
});

describe("wrapAnsiLines", () => {
  test("wraps each logical line independently", () => {
    expect(wrapAnsiLines(["abcd", "xy"], 2)).toEqual(["ab", "cd", "xy"]);
  });
});
