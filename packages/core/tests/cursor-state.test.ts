import { test, expect, describe } from "bun:test";
import { CursorState } from "../src/render/frame/cursor-state";
import { SHOW_CURSOR } from "../src/render/frame/codes";

describe("CursorState", () => {
  test("emits Show+CUP on first move, then nothing when unchanged", () => {
    const cur = new CursorState();
    const first = cur.move(10, 3);

    expect(first).toContain(SHOW_CURSOR);
    expect(first).toContain("[10;3H");
    expect(cur.move(10, 3)).toBe("");
  });

  test("emits again after position changes or reset", () => {
    const cur = new CursorState();

    cur.move(1, 1);
    expect(cur.move(2, 1)).toContain("[2;1H");
    cur.reset();
    expect(cur.move(2, 1)).toContain("[2;1H");
  });
});
