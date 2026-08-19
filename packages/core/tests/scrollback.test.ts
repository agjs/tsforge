import { test, expect } from "bun:test";
import { Scrollback } from "../src/render/frame/scrollback";

/** The wrapped rows a fresh Scrollback would produce for the same content —
 *  the from-scratch truth the incremental cache must always equal. */
function freshVisible(
  feed: (sb: Scrollback) => void,
  cols: number,
  rows: number,
  offset: number
): string[] {
  const sb = new Scrollback(5_000, rows);

  sb.setWrapCols(cols);
  feed(sb);
  sb.scroll(offset);

  return sb.visible();
}

test("incremental wrap cache equals from-scratch wrap while scrolled up", () => {
  const sb = new Scrollback(5_000, 10);

  sb.setWrapCols(20);

  const feedInitial = (target: Scrollback): void => {
    for (let i = 0; i < 80; i += 1) {
      target.append(`line ${String(i)} with some words that wrap wider\n`);
    }
  };

  feedInitial(sb);
  sb.scroll(15); // scrolled up — the old code re-wrapped everything per append

  // Stream more while scrolled up: partial chunks + completed lines.
  const streamed: string[] = [];

  for (let i = 0; i < 60; i += 1) {
    const chunk = i % 3 === 2 ? ` tail-${String(i)}\n` : ` tok-${String(i)}`;

    streamed.push(chunk);
    sb.append(chunk);
  }

  const expected = freshVisible(
    (target) => {
      feedInitial(target);

      for (const chunk of streamed) {
        target.append(chunk);
      }
    },
    20,
    10,
    sb.following ? 0 : 15
  );

  // The incremental path must render exactly what a cold wrap would.
  expect(sb.visible()).toEqual(expected);
});

test("resize invalidates the incremental cache (no stale wraps)", () => {
  const sb = new Scrollback(5_000, 6);

  sb.setWrapCols(30);

  for (let i = 0; i < 30; i += 1) {
    sb.append(`row ${String(i)} `.repeat(4) + "\n");
  }

  sb.scroll(5);
  sb.append("streamed after scroll ");
  sb.reflow(18); // width change → full re-wrap

  const cold = new Scrollback(5_000, 6);

  cold.setWrapCols(18);

  for (let i = 0; i < 30; i += 1) {
    cold.append(`row ${String(i)} `.repeat(4) + "\n");
  }

  cold.append("streamed after scroll ");

  // Reflow re-pins by anchor; compare full wrapped content via dump + a
  // bottom view (follow) so anchor policy differences don't confound.
  sb.follow();
  cold.follow();
  expect(sb.visible()).toEqual(cold.visible());
});

test("trim at capacity invalidates and stays consistent", () => {
  const sb = new Scrollback(50, 5);

  sb.setWrapCols(40);

  for (let i = 0; i < 400; i += 1) {
    sb.append(`cap line ${String(i)}\n`);
  }

  // Content is bounded (capacity + slack) and the newest lines are visible.
  expect(sb.length).toBeLessThanOrEqual(50 + 256 + 1);

  const view = sb.visible();

  expect(view.at(-1) ?? "").toContain("cap line 399");
});

test("streaming a partial line updates the tail without duplicating rows", () => {
  const sb = new Scrollback(5_000, 5);

  sb.setWrapCols(10);
  sb.append("start\n");
  sb.scroll(1); // force the scrolled-up (cached) path
  sb.follow();

  // Grow one long partial across appends: rows must reflect the FULL partial
  // exactly once (no stale/duplicate tail rows from earlier partial states).
  sb.append("aaaa");
  sb.append("bbbb");
  sb.append("cccc"); // 12 chars → wraps to 2 rows at width 10
  sb.scroll(0);

  const cold = new Scrollback(5_000, 5);

  cold.setWrapCols(10);
  cold.append("start\n");
  cold.append("aaaabbbbcccc");

  expect(sb.visible()).toEqual(cold.visible());
});
