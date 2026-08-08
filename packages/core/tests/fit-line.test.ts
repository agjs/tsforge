import { test, expect, describe } from "bun:test";
import { fitAnsiLine } from "../src/render/frame/fit-line";
import { RESET } from "../src/render/style";

describe("fitAnsiLine", () => {
  test("keeps SGR when the visible width fits", () => {
    const red = `\x1b[31mhi\x1b[0m`;
    const out = fitAnsiLine(red, 10);

    expect(out.startsWith(red)).toBe(true);
    expect(out).toContain(RESET);
    expect(out.endsWith(" ".repeat(8))).toBe(true); // 10 - 2 visible
  });

  test("truncates to plain text when overflowing", () => {
    const red = `\x1b[31mabcdef\x1b[0m`;
    const out = fitAnsiLine(red, 3);

    expect(out).toBe(`abc${RESET}`);
    expect(out).not.toContain("[31m");
  });

  test("empty line pads to width", () => {
    expect(fitAnsiLine("", 4)).toBe(`${RESET}    `);
  });
});
