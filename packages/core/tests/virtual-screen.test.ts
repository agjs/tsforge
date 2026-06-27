import { describe, expect, test } from "bun:test";
import { VirtualScreen } from "./helpers/virtual-screen";

const ESC = "\x1b";

describe("VirtualScreen — emulator fidelity", () => {
  test("absolute cursor positioning writes at the right cell", () => {
    const s = new VirtualScreen(5, 20);

    s.feed(`${ESC}[3;1Hhello`);
    expect(s.row(3)).toBe("hello");
    expect(s.row(1)).toBe("");
  });

  test("erase-line (2K) clears the whole row before a rewrite", () => {
    const s = new VirtualScreen(5, 20);

    s.feed(`${ESC}[1;1Hlong original text`);
    s.feed(`${ESC}[1;1H${ESC}[2Kshort`);
    expect(s.row(1)).toBe("short");
  });

  test("a bare rewrite without erase leaves a trailing tail (ghost)", () => {
    const s = new VirtualScreen(5, 20);

    s.feed(`${ESC}[1;1Hlongtext`);
    s.feed(`${ESC}[1;1Hab`); // no 2K — old tail must remain
    expect(s.row(1)).toBe("abngtext");
  });

  test("LF at the bottom margin scrolls the region up", () => {
    const s = new VirtualScreen(4, 10);

    s.feed(`${ESC}[1;1Ha`);
    s.feed(`${ESC}[2;1Hb`);
    s.feed(`${ESC}[3;1Hc`);
    s.feed(`${ESC}[4;1Hd`);
    // Cursor at bottom row, a newline scrolls everything up one.
    s.feed(`${ESC}[4;1H\n`);
    expect(s.row(1)).toBe("b");
    expect(s.row(2)).toBe("c");
    expect(s.row(3)).toBe("d");
    expect(s.row(4)).toBe("");
  });

  test("DECSTBM confines scrolling to the region; rows below stay put", () => {
    const s = new VirtualScreen(5, 10);

    // Pin the bottom two rows out of the scroll region.
    s.feed(`${ESC}[4;1Hfooter1`);
    s.feed(`${ESC}[5;1Hfooter2`);
    s.feed(`${ESC}[1;3r`); // region = rows 1..3
    s.feed(`${ESC}[1;1Ha`);
    s.feed(`${ESC}[2;1Hb`);
    s.feed(`${ESC}[3;1Hc`);
    s.feed(`${ESC}[3;1H\n`); // scroll only within 1..3
    expect(s.row(1)).toBe("b");
    expect(s.row(2)).toBe("c");
    expect(s.row(3)).toBe("");
    expect(s.row(4)).toBe("footer1"); // untouched
    expect(s.row(5)).toBe("footer2"); // untouched
  });

  test("save/restore cursor (ESC 7 / ESC 8) round-trips", () => {
    const s = new VirtualScreen(5, 20);

    s.feed(`${ESC}[2;5H`); // move
    s.feed(`${ESC}7`); // save
    s.feed(`${ESC}[5;1Hother`);
    s.feed(`${ESC}8X`); // restore, then write
    expect(s.row(2)).toBe("    X"); // col 5 on row 2
  });

  test("SGR colour and bracketed-paste sequences are ignored", () => {
    const s = new VirtualScreen(3, 20);

    s.feed(`${ESC}[?2004h${ESC}[1;1H${ESC}[31mred${ESC}[0m`);
    expect(s.row(1)).toBe("red");
  });

  test("autowrap moves past the right edge onto the next row", () => {
    const s = new VirtualScreen(3, 4);

    s.feed(`${ESC}[1;1Habcdef`);
    expect(s.row(1)).toBe("abcd");
    expect(s.row(2)).toBe("ef");
  });

  test("rowsContaining counts duplicate occurrences across rows", () => {
    const s = new VirtualScreen(5, 20);

    s.feed(`${ESC}[1;1Hhi`);
    s.feed(`${ESC}[2;1Hhi`);
    s.feed(`${ESC}[3;1Hbye`);
    expect(s.rowsContaining("hi")).toBe(2);
    expect(s.rowsContaining("bye")).toBe(1);
  });
});
