import { test, expect, describe } from "bun:test";
import { LiveRegion, type ILiveRegionOut } from "../src/render/live-region";

/** A capturing sink that records every write, with a fixed reported width. */
function sink(columns: number): ILiveRegionOut & { writes: string[] } {
  const writes: string[] = [];

  return {
    writes,
    isTTY: true,
    columns,
    write(data: string): boolean {
      writes.push(data);

      return true;
    },
  };
}

describe("LiveRegion", () => {
  test("erase climbs PHYSICAL rows, accounting for soft-wrapped lines", () => {
    const out = sink(10);
    const region = new LiveRegion(out);

    // Two logical lines: the second is 60 cols wide at width 10 → 6 physical
    // rows. Total drawn = 1 + 6 = 7 rows.
    const wide = "x".repeat(60);

    region.render(["short", wide]);
    region.render(["again", wide]);

    // The SECOND render must first climb 7-1 = 6 rows to reach the block top.
    // The old logical-line count would have climbed only 2-1 = 1 row, leaving
    // ghost fragments of the previous wrapped line.
    expect(out.writes[1]?.startsWith("\x1b[6A")).toBe(true);
  });

  test("a non-wrapping block climbs one row per logical line", () => {
    const out = sink(80);
    const region = new LiveRegion(out);

    region.render(["a", "b", "c"]);
    region.render(["d", "e", "f"]);

    // 3 lines, none wrap at width 80 → climb 3-1 = 2 rows.
    expect(out.writes[1]?.startsWith("\x1b[2A")).toBe(true);
  });

  test("each render ends with an SGR reset so color can't bleed into scrollback", () => {
    const out = sink(80);
    const region = new LiveRegion(out);

    region.render(["\x1b[31mred line"]);

    expect(out.writes[0]?.endsWith("\x1b[0m")).toBe(true);
  });

  test("unknown width (columns 0) falls back to one row per line", () => {
    const out = sink(0);
    const region = new LiveRegion(out);

    region.render(["x".repeat(200)]);
    region.render(["y"]);

    // No width to wrap against → one row for the single logical line → \r ESC[0J.
    expect(out.writes[1]?.startsWith("\r\x1b[0J")).toBe(true);
  });

  test("a non-TTY sink is a no-op", () => {
    const writes: string[] = [];
    const region = new LiveRegion({
      write: (d) => (writes.push(d), true),
      isTTY: false,
    });

    region.render(["anything"]);

    expect(writes).toHaveLength(0);
  });
});
