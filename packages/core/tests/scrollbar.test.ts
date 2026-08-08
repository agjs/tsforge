import { describe, expect, test } from "bun:test";
import {
  needsScrollbar,
  thumbWindow,
  formatScrollbarColumn,
  overlayScrollbarCol,
  type IScrollMetrics,
} from "../src/render/frame/scrollbar";
import { displayWidth } from "../src/render/width";
import { stripSgr } from "../src/render/frame/ansi-plain";

function metrics(
  partial: Partial<IScrollMetrics> &
    Pick<IScrollMetrics, "total" | "viewport" | "offset">
): IScrollMetrics {
  return {
    following: partial.following ?? false,
    ...partial,
  };
}

describe("needsScrollbar", () => {
  test("hidden when content fits", () => {
    expect(
      needsScrollbar(metrics({ total: 10, viewport: 10, offset: 0 }))
    ).toBe(false);
    expect(
      needsScrollbar(metrics({ total: 5, viewport: 10, offset: 0 }))
    ).toBe(false);
  });

  test("shown when content overflows", () => {
    expect(
      needsScrollbar(metrics({ total: 11, viewport: 10, offset: 0 }))
    ).toBe(true);
  });
});

describe("thumbWindow", () => {
  test("null when no overflow", () => {
    expect(
      thumbWindow(metrics({ total: 5, viewport: 10, offset: 0 }), 10)
    ).toBeNull();
  });

  test("sits at the bottom while following", () => {
    const win = thumbWindow(
      metrics({ total: 100, viewport: 20, offset: 0, following: true }),
      20
    );

    expect(win).not.toBeNull();
    expect(win?.end).toBe(20);
    expect(win!.end - win!.start).toBeGreaterThanOrEqual(1);
  });

  test("moves toward the top as offset shrinks", () => {
    const track = 20;
    const atBottom = thumbWindow(
      metrics({ total: 100, viewport: 20, offset: 80, following: false }),
      track
    );
    const atTop = thumbWindow(
      metrics({ total: 100, viewport: 20, offset: 0, following: false }),
      track
    );

    expect(atTop?.start).toBe(0);
    expect(atBottom?.start).toBeGreaterThan(atTop!.start);
  });

  test("thumb length scales with viewport/total", () => {
    const small = thumbWindow(
      metrics({ total: 200, viewport: 20, offset: 0 }),
      40
    );
    const large = thumbWindow(
      metrics({ total: 40, viewport: 20, offset: 0 }),
      40
    );

    expect(large!.end - large!.start).toBeGreaterThan(small!.end - small!.start);
  });
});

describe("formatScrollbarColumn", () => {
  test("paints █ on the thumb and spaces on the track", () => {
    const col = formatScrollbarColumn(
      metrics({ total: 40, viewport: 10, offset: 0, following: false }),
      10,
      false
    );

    expect(col).not.toBeNull();
    expect(col!.length).toBe(10);
    expect(col![0]).toBe("█");
    expect(col!.some((c) => c === " ")).toBe(true);
    expect(col!.filter((c) => c === "█").length).toBeGreaterThan(0);
  });

  test("returns null when content fits", () => {
    expect(
      formatScrollbarColumn(
        metrics({ total: 5, viewport: 10, offset: 0 }),
        10,
        false
      )
    ).toBeNull();
  });
});

describe("overlayScrollbarCol", () => {
  test("keeps total width and parks the thumb in the last column", () => {
    const line = "hello world";
    const out = overlayScrollbarCol(line, 20, "█");
    const plain = stripSgr(out);

    expect(displayWidth(plain)).toBe(20);
    expect(plain.endsWith("█")).toBe(true);
    expect(plain.startsWith("hello")).toBe(true);
  });
});
