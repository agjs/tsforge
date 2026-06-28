import { describe, expect, test } from "bun:test";
import { ScreenBuffer } from "../src/render/screen";
import { VirtualScreen } from "./helpers/virtual-screen";

const ESC = "\x1b";
const at = (r: number, c: number): string => `${ESC}[${r};${c}H`;
const clear = `${ESC}[2K`;

describe("ScreenBuffer — damage diff", () => {
  test("an unchanged repaint emits no cell writes", () => {
    const buf = new ScreenBuffer(5, 20);
    const frame = `${at(1, 1)}${clear}hello`;

    buf.flush(frame); // first paint
    const second = buf.flush(frame); // identical repaint

    // The delta is empty — nothing on screen changed. The cursor park is a
    // separate, explicit step the caller adds.
    expect(second).toBe("");
    expect(buf.parkSequence()).toMatch(/\[\d+;\d+H/);
  });

  test("emits only the cells that actually changed", () => {
    const buf = new ScreenBuffer(5, 20);

    buf.flush(`${at(1, 1)}${clear}hello world`);
    const delta = buf.flush(`${at(1, 1)}${clear}hello WORLD`);

    // Only "WORLD" (from column 7) is redrawn, not the unchanged "hello ".
    expect(delta).toContain("WORLD");
    expect(delta).not.toContain("hello");
    // The damaged run starts at column 7.
    expect(delta).toContain(`${ESC}[1;7H`);
  });

  test("clears vacated cells by writing spaces (no ESC[2K needed)", () => {
    const buf = new ScreenBuffer(5, 20);

    const first = buf.flush(`${at(1, 1)}${clear}longer text`);
    const delta = buf.flush(`${at(1, 1)}${clear}short`);

    // Applying both deltas to a real terminal leaves only "short" — the tail
    // "er text" was erased by writing spaces, with no ESC[2K in the delta.
    const v = new VirtualScreen(5, 20);

    v.feed(first);
    v.feed(delta);
    expect(v.row(1)).toBe("short");
    expect(delta).not.toContain(clear);
  });

  test("overwriting a wide cell's half clears the orphaned half", () => {
    const buf = new ScreenBuffer(3, 10);

    buf.flush(`${at(1, 1)}世`); // col1 wide char, col2 its continuation
    const delta = buf.flush(`${at(1, 1)}x`); // overwrite the left half with a narrow char

    // The diff must also blank the orphaned continuation column (write a space at
    // col2), not leave a dangling right half — so the run is "x " not "x".
    expect(delta).toContain(`${at(1, 1)}x `);
  });

  test("wide characters occupy two columns and realign following cells", () => {
    const buf = new ScreenBuffer(5, 20);

    buf.flush(`${at(1, 1)}${clear}世界x`);
    const delta = buf.flush(`${at(1, 1)}${clear}ab`);

    // "世界x" (5 cols) → "ab": the diff must clear the extra trailing columns.
    const v = new VirtualScreen(5, 20);

    v.feed(`${at(1, 1)}${clear}世界x`);
    v.feed(delta);
    expect(v.row(1)).toBe("ab");
  });
});

describe("ScreenBuffer — fidelity vs a real terminal", () => {
  const frames = [
    `${at(2, 1)}${clear}status: idle`,
    `${at(1, 1)}${clear}› hello${at(1, 9)}`,
    `${at(2, 1)}${clear}status: running 世界`,
    `${at(1, 1)}${clear}› hello world${at(1, 15)}`,
  ];

  test("applying the deltas reproduces the same grid as the raw frames", () => {
    const raw = new VirtualScreen(5, 40);
    const diffed = new VirtualScreen(5, 40);
    const buf = new ScreenBuffer(5, 40);

    for (const frame of frames) {
      raw.feed(frame);
      diffed.feed(buf.flush(frame) + buf.parkSequence());
    }

    expect(diffed.text()).toBe(raw.text());
    expect(diffed.cursorPosition()).toEqual(raw.cursorPosition());
  });

  test("the diffed stream is never longer than re-sending every frame", () => {
    const buf = new ScreenBuffer(5, 40);
    let diffedBytes = 0;
    let rawBytes = 0;

    // Re-send the SAME frame repeatedly: raw cost is constant, diffed collapses
    // to just cursor parks after the first paint.
    for (let i = 0; i < 5; i += 1) {
      const frame = `${at(2, 1)}${clear}status: idle`;

      rawBytes += frame.length;
      diffedBytes += (buf.flush(frame) + buf.parkSequence()).length;
    }

    expect(diffedBytes).toBeLessThan(rawBytes);
  });
});
