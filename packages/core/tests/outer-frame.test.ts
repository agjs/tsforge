import { test, expect, describe } from "bun:test";
import {
  OUTER_CHROME,
  OUTER_MARGIN,
  outerInsets,
  wrapOuterFrame,
  frameContentRow,
} from "../src/render/frame/outer-frame";
import { stripSgr } from "../src/render/frame/ansi-plain";

describe("outerInsets", () => {
  test("reserves margin+border on every side", () => {
    const insets = outerInsets(24, 100);

    expect(insets.originRow).toBe(OUTER_CHROME);
    expect(insets.originCol).toBe(OUTER_CHROME);
    expect(insets.contentRows).toBe(24 - 2 * OUTER_CHROME);
    expect(insets.contentCols).toBe(100 - 2 * OUTER_CHROME);
  });
});

describe("wrapOuterFrame", () => {
  test("wraps content in a closed chrome box with outer margin", () => {
    const termRows = 10;
    const termCols = 20;
    const { contentRows, contentCols } = outerInsets(termRows, termCols);
    const content = Array.from({ length: contentRows }, (_, i) =>
      `r${String(i)}`.padEnd(contentCols, ".")
    );
    const framed = wrapOuterFrame(content, termRows, termCols, false);

    expect(framed).toHaveLength(termRows);
    expect(framed.every((line) => stripSgr(line).length === termCols)).toBe(
      true
    );

    const top = stripSgr(framed[OUTER_MARGIN] ?? "");
    const bottom = stripSgr(framed[termRows - OUTER_MARGIN - 1] ?? "");
    const mid = stripSgr(framed[OUTER_CHROME] ?? "");

    expect(stripSgr(framed[0] ?? "").trim()).toBe("");
    expect(stripSgr(framed[termRows - 1] ?? "").trim()).toBe("");
    expect(top.startsWith(" ".repeat(OUTER_MARGIN) + "╭")).toBe(true);
    expect(top.endsWith("╮" + " ".repeat(OUTER_MARGIN))).toBe(true);
    expect(bottom.startsWith(" ".repeat(OUTER_MARGIN) + "╰")).toBe(true);
    expect(bottom.endsWith("╯" + " ".repeat(OUTER_MARGIN))).toBe(true);
    expect(bottom).not.toContain("┴");
    expect(mid[OUTER_MARGIN]).toBe("│");
    expect(mid[termCols - OUTER_MARGIN - 1]).toBe("│");
    expect(mid).toContain("r0");
  });

  test("bottom edge stamps ┴ under the panel gutter so the spine closes", () => {
    const termRows = 10;
    const termCols = 20;
    const { contentRows, contentCols, originCol } = outerInsets(
      termRows,
      termCols
    );
    const splitCol = 8;
    const content = Array.from({ length: contentRows }, () =>
      "".padEnd(contentCols, ".")
    );
    const framed = wrapOuterFrame(content, termRows, termCols, {
      color: false,
      splitCol,
    });
    const bottom = stripSgr(framed[termRows - OUTER_MARGIN - 1] ?? "");

    expect(bottom[originCol + splitCol]).toBe("┴");
    expect(bottom.startsWith(" ".repeat(OUTER_MARGIN) + "╰")).toBe(true);
    expect(bottom.endsWith("╯" + " ".repeat(OUTER_MARGIN))).toBe(true);
  });

  test("frameContentRow keeps content inside the side rails", () => {
    const plain = stripSgr(frameContentRow("hi", 16, false));

    expect(plain).toHaveLength(16);
    expect(plain[OUTER_MARGIN]).toBe("│");
    expect(plain[15 - OUTER_MARGIN]).toBe("│");
    expect(plain).toContain("hi");
  });

  test("full-bleed hairline rows use ├/┤ so the rule joins the outer rails", () => {
    const termRows = 8;
    const termCols = 20;
    const { contentRows, contentCols } = outerInsets(termRows, termCols);
    const split = 6;
    const rule =
      "─".repeat(split) +
      "┬" +
      "─".repeat(Math.max(0, contentCols - split - 1));
    const content = Array.from({ length: contentRows }, (_, i) =>
      i === 1 ? rule : "".padEnd(contentCols, " ")
    );
    const framed = wrapOuterFrame(content, termRows, termCols, {
      color: false,
      splitCol: split,
    });
    const plain = stripSgr(framed[OUTER_CHROME + 1] ?? "");

    expect(plain[OUTER_MARGIN]).toBe("├");
    expect(plain[termCols - OUTER_MARGIN - 1]).toBe("┤");
    expect(plain).toContain("┬");
    // Interior rows keep plain │ rails.
    expect(stripSgr(framed[OUTER_CHROME] ?? "")[OUTER_MARGIN]).toBe("│");
  });

  test("panel-only under-rule joins with ├ gutter and ┤ outer rail", () => {
    const termRows = 8;
    const termCols = 20;
    const { contentRows, contentCols, originCol } = outerInsets(
      termRows,
      termCols
    );
    const split = 6;
    const panelRule =
      " ".repeat(split) +
      "├" +
      "─".repeat(Math.max(0, contentCols - split - 1));
    const content = Array.from({ length: contentRows }, (_, i) =>
      i === 1 ? panelRule : "".padEnd(contentCols, " ")
    );
    const framed = wrapOuterFrame(content, termRows, termCols, {
      color: false,
      splitCol: split,
    });
    const plain = stripSgr(framed[OUTER_CHROME + 1] ?? "");

    expect(plain[OUTER_MARGIN]).toBe("│");
    expect(plain[originCol + split]).toBe("├");
    expect(plain[termCols - OUTER_MARGIN - 1]).toBe("┤");
    expect(
      plain.slice(originCol + split + 1, termCols - OUTER_MARGIN - 1)
    ).toMatch(/^─+$/);
  });
});
