import { describe, expect, test } from "bun:test";
import { computeRegions } from "../src/render/layout";

describe("computeRegions", () => {
  test("bottom-anchors the bar on a normal terminal", () => {
    const r = computeRegions({ rows: 24, reserved: 3 });

    expect(r.segRow).toBe(24); // last row
    expect(r.borderRow).toBe(23); // border just above
    expect(r.inputRow).toBe(22); // prompt above the border
    expect(r.regionEnd).toBe(21); // scroll region ends above the reserved block
    expect(r.editorTop).toBe(22); // no editor block ⇒ equals inputRow
  });

  test("an editor block lifts the scroll-region boundary and editor top", () => {
    const r = computeRegions({ rows: 24, reserved: 3, editorRows: 4 });

    expect(r.regionEnd).toBe(17); // 24 - 3 - 4
    expect(r.editorTop).toBe(18); // inputRow(22) - 4
    expect(r.inputRow).toBe(22); // input row itself is unchanged
    expect(r.segRow).toBe(24);
  });

  test("clamps every row to >= 1 when the terminal is shrunk below reserved", () => {
    const r = computeRegions({ rows: 2, reserved: 3, editorRows: 5 });

    expect(r.regionEnd).toBeGreaterThanOrEqual(1);
    expect(r.borderRow).toBeGreaterThanOrEqual(1);
    expect(r.segRow).toBeGreaterThanOrEqual(1);
    expect(r.inputRow).toBeGreaterThanOrEqual(1);
    expect(r.editorTop).toBeGreaterThanOrEqual(1);
  });

  test("re-windows monotonically as the editor block grows (a255898 class)", () => {
    const grow = [0, 1, 2, 3, 4].map(
      (h) => computeRegions({ rows: 24, reserved: 3, editorRows: h }).regionEnd
    );

    // Each extra editor row pushes the scroll-region boundary up by exactly one.
    expect(grow).toEqual([21, 20, 19, 18, 17]);
  });

  test("border/seg/input rows do not depend on reserved or editorRows", () => {
    const a = computeRegions({ rows: 40 });
    const b = computeRegions({ rows: 40, reserved: 3, editorRows: 6 });

    expect(a.segRow).toBe(b.segRow);
    expect(a.borderRow).toBe(b.borderRow);
    expect(a.inputRow).toBe(b.inputRow);
  });
});
