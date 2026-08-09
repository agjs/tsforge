import { describe, expect, test } from "bun:test";
import {
  codePointWidth,
  displayWidth,
  padToWidth,
  sliceToWidth,
} from "../src/render/width";
import { table } from "../src/render/box";

describe("codePointWidth", () => {
  test("ASCII is one column", () => {
    expect(codePointWidth("a".codePointAt(0)!)).toBe(1);
  });

  test("CJK ideographs are two columns", () => {
    expect(codePointWidth("世".codePointAt(0)!)).toBe(2);
    expect(codePointWidth("界".codePointAt(0)!)).toBe(2);
  });

  test("fullwidth forms are two columns", () => {
    expect(codePointWidth("Ａ".codePointAt(0)!)).toBe(2); // U+FF21
  });

  test("combining marks and controls are zero columns", () => {
    expect(codePointWidth(0x0301)).toBe(0); // combining acute accent
    expect(codePointWidth(0x200b)).toBe(0); // zero-width space
    expect(codePointWidth(0x09)).toBe(0); // tab (control)
  });
});

describe("displayWidth", () => {
  test("counts plain ASCII as its length", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  test("counts CJK as two columns each", () => {
    expect(displayWidth("世界")).toBe(4);
    expect(displayWidth("a世b")).toBe(4);
  });

  test("a base + combining mark is one column", () => {
    expect(displayWidth("é")).toBe(1); // é as two code points
  });

  test("wide emoji and ZWJ sequences are two columns", () => {
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("😊")).toBe(2);
    expect(displayWidth("👨‍👩‍👧")).toBe(2); // single grapheme via ZWJ
  });

  test("lone VS16 is zero-width; Neutral emoji stay one column (iTerm advance)", () => {
    expect(displayWidth("\uFE0F")).toBe(0);
    // U+1F5A5 / U+1F6CB are East-Asian Neutral — terminals advance 1 even with VS16.
    expect(displayWidth("🖥️")).toBe(1);
    expect(displayWidth("🛋️")).toBe(1);
    expect(displayWidth("❤️")).toBe(1); // U+2764 U+FE0F
  });

  test("flags (regional indicator pairs) are two columns", () => {
    expect(displayWidth("🇯🇵")).toBe(2);
  });
});

describe("sliceToWidth", () => {
  test("never splits a wide cell", () => {
    // "a世" is 3 columns; a budget of 2 must stop before 世, not inside it.
    expect(sliceToWidth("a世b", 2)).toEqual({ text: "a", width: 1 });
    expect(sliceToWidth("a世b", 3)).toEqual({ text: "a世", width: 3 });
  });

  test("returns the whole string when it fits", () => {
    expect(sliceToWidth("hi", 10)).toEqual({ text: "hi", width: 2 });
  });

  test("empty for non-positive budget", () => {
    expect(sliceToWidth("hi", 0)).toEqual({ text: "", width: 0 });
  });
});

describe("table alignment (box.ts integration)", () => {
  test("columns stay aligned when a cell holds wide characters", () => {
    // Column 0 mixes a 1-col cell and a 2-col CJK cell; every rendered row must
    // be the same display width, or the right border would zig-zag.
    const out = table(
      [
        ["a", "b"],
        ["世", "x"],
      ],
      false
    );
    const widths = out.split("\n").map((line) => displayWidth(line));

    expect(new Set(widths).size).toBe(1);
  });
});

describe("padToWidth", () => {
  test("pads by columns, not code units", () => {
    expect(padToWidth("世", 4)).toBe("世  "); // 2 columns + 2 spaces
    expect(padToWidth("ab", 4)).toBe("ab  ");
  });

  test("leaves already-wide strings untouched", () => {
    expect(padToWidth("hello", 3)).toBe("hello");
  });
});
