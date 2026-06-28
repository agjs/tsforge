import { describe, expect, test } from "bun:test";
import { renderDiff } from "../src/render/diff";
import { displayWidth } from "../src/render/width";

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(SGR, "");

describe("renderDiff — unified", () => {
  test("shows unchanged lines as context, not as -/+ churn", () => {
    const old = "a\nb\nc";
    const next = "a\nB\nc";
    const out = strip(renderDiff(old, next, { color: false }));
    const lines = out.split("\n");

    // The naive renderer printed all of old then all of new (6 lines); the LCS
    // diff keeps `a` and `c` as single context lines and changes only `b`.
    expect(lines).toContain("  a");
    expect(lines).toContain("  c");
    expect(lines.filter((l) => l.startsWith("- "))).toEqual(["- b"]);
    expect(lines.filter((l) => l.startsWith("+ "))).toEqual(["+ B"]);
  });

  test("a pure addition emits only + lines plus context", () => {
    const out = strip(renderDiff("a\nc", "a\nb\nc", { color: false }));

    expect(out.split("\n").filter((l) => l.startsWith("+ "))).toEqual(["+ b"]);
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toEqual([]);
  });

  test("a no-op diff keeps leading context, not just a bare gap marker", () => {
    const same = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const lines = strip(renderDiff(same, same, { color: false, context: 3 }))
      .split("\n")
      .filter((l) => l.length > 0);

    // Not collapsed to a single "⋯": some real context survives.
    expect(lines.some((l) => l.includes("line0"))).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.filter((l) => l.startsWith("- ")).length).toBe(0);
    expect(lines.filter((l) => l.startsWith("+ ")).length).toBe(0);
  });

  test("collapses large unchanged runs to a gap marker", () => {
    const common = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const out = strip(
      renderDiff(`${common}\nX`, `${common}\nY`, { color: false, context: 2 })
    );

    expect(out).toContain("⋯");
    // Only the inner context survives, not all 20 unchanged lines.
    expect(out.split("\n").length).toBeLessThan(10);
  });

  test("color:false carries no ANSI escapes", () => {
    const out = renderDiff("foo", "bar", { color: false });

    expect(out).toBe("- foo\n+ bar");
  });

  test("falls back to a plain replacement on very large inputs (no O(n·m) blowup)", () => {
    // 600×600 = 360k DP cells, past the guard — must not allocate the matrix or
    // hang; it degrades to all-old-removed then all-new-added.
    const old = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const next = Array.from({ length: 600 }, (_, i) => `b${i}`).join("\n");
    const lines = strip(
      renderDiff(old, next, { color: false, wordLevel: false })
    ).split("\n");

    expect(lines.filter((l) => l.startsWith("- ")).length).toBe(600);
    expect(lines.filter((l) => l.startsWith("+ ")).length).toBe(600);
  });
});

describe("renderDiff — word level", () => {
  test("highlights only the changed word in a one-line swap", () => {
    const out = renderDiff("the quick fox", "the slow fox", { color: true });

    // Shared words are not bolded; the changed word is painted bold.
    expect(out).toContain("\x1b[1m"); // bold appears (changed word)
    expect(strip(out)).toContain("the quick fox");
    expect(strip(out)).toContain("the slow fox");
  });
});

describe("renderDiff — side by side", () => {
  test("aligns two equal-width columns, never splitting wide cells", () => {
    const out = strip(
      renderDiff("a\n世界x", "a\nb", {
        color: false,
        sideBySide: true,
        columns: 20,
      })
    );
    const widths = out.split("\n").map((l) => displayWidth(l));

    expect(new Set(widths).size).toBe(1); // every row the same display width
  });
});
