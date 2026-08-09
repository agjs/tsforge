import { describe, expect, test } from "bun:test";
import { withOpaqueBg } from "../src/render/frame/opaque-bg";
import { RESET, paint, truecolorBg } from "../src/render/style";
import { fitAnsiLine } from "../src/render/frame/fit-line";

const BG = truecolorBg(20, 20, 20);

describe("withOpaqueBg", () => {
  test("prefixes bg and leaves it active for BCE erase", () => {
    const out = withOpaqueBg("hello", BG);

    expect(out.startsWith(BG)).toBe(true);
    expect(out.endsWith(BG) || out.endsWith("hello")).toBe(true);
    expect(out).toBe(`${BG}hello`);
  });

  test("re-applies bg after every SGR reset (paint + pad spaces)", () => {
    const styled = paint("ok", "\x1b[32m", true);
    const fitted = fitAnsiLine(styled, 8);
    const out = withOpaqueBg(fitted, BG);

    // fitAnsiLine: styled + RESET + pad spaces → opaque must paint pad too.
    expect(out.startsWith(BG)).toBe(true);
    expect(out).toContain(`${RESET}${BG}`);
    expect(out.endsWith(`${BG}${" ".repeat(6)}`)).toBe(true);
  });

  test("empty bg is a no-op", () => {
    expect(withOpaqueBg("x", "")).toBe("x");
  });
});
