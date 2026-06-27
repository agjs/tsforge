import { test, expect, describe } from "bun:test";
import {
  StatusBar,
  buildBarFrame,
  buildInputFrame,
  buildEditorFrame,
  buildOverlayFrame,
  type IStatusInfo,
  type IStatusBarTerminal,
} from "../src/render";

const INFO: IStatusInfo = {
  model: "qwen3.6-27b",
  contextTokens: 8000,
  contextWindow: 32000,
  turns: 2,
  elapsedMs: 12000,
  status: "done",
  scope: "src/**",
  tokensPerSecond: 48,
};

class FakeTerm implements IStatusBarTerminal {
  readonly writes: string[] = [];

  constructor(
    readonly isTTY: boolean,
    public rows: number,
    readonly columns: number
  ) {}

  write(data: string): boolean {
    this.writes.push(data);

    return true;
  }

  text(): string {
    return this.writes.join("");
  }
}

describe("buildBarFrame", () => {
  test("targets the bottom row, clears it, and preserves the cursor", () => {
    const frame = buildBarFrame(INFO, 80, 24, false);

    expect(frame.startsWith("\x1b7")).toBe(true); // save cursor
    expect(frame.endsWith("\x1b8")).toBe(true); // restore cursor
    expect(frame).toContain("\x1b[23;1H"); // border row (rows-1)
    expect(frame).toContain("\x1b[24;1H"); // segments row (rows)
    expect(frame).toContain("\x1b[2K"); // clear the line
    expect(frame).toContain("╶"); // top border tick
    expect(frame).toContain("qwen3.6-27b");
    expect(frame).toContain("48 tok/s");
    expect(frame).toContain("done");
  });

  test("drops segments that don't fit the width", () => {
    // Narrow: later segments (scope) are dropped rather than cut mid-escape.
    expect(buildBarFrame(INFO, 16, 24, false)).not.toContain("src/**");
    // Wide: the full set is shown.
    expect(buildBarFrame(INFO, 200, 24, false)).toContain("src/**");
  });

  // WS4: the spinner activity rides IN the bar (not on the readline input line,
  // which it used to erase). When present it renders; between turns it's absent.
  test("renders the live activity indicator when present", () => {
    const frame = buildBarFrame(
      { ...INFO, activity: "⠋ thinking · 12s" },
      200,
      24,
      false
    );

    expect(frame).toContain("⠋ thinking · 12s");
  });

  test("omits the activity segment between turns (no activity)", () => {
    expect(buildBarFrame(INFO, 200, 24, false)).not.toContain("thinking");
  });
});

describe("StatusBar activation", () => {
  test("stays inactive on a non-TTY and writes nothing", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = new StatusBar(term);

    bar.install(INFO);

    expect(bar.active).toBe(false);
    expect(term.writes).toHaveLength(0);
  });

  test("stays inactive on a tiny terminal", () => {
    const bar = new StatusBar(new FakeTerm(true, 3, 80));

    bar.install(INFO);

    expect(bar.active).toBe(false);
  });

  test("stays inactive when disabled", () => {
    const bar = new StatusBar(new FakeTerm(true, 24, 80), false);

    bar.install(INFO);

    expect(bar.active).toBe(false);
  });

  test("activates on a real terminal and reserves a scroll region", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);

    expect(bar.active).toBe(true);
    expect(term.text()).toContain("\x1b[1;22r"); // reserve bottom 2 rows (rows-2)
    expect(term.text()).toContain("\x1b[24;1H"); // segments drawn on row 24
  });

  test("teardown resets the scroll region and deactivates", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);
    term.writes.length = 0;
    bar.teardown();

    expect(bar.active).toBe(false);
    expect(term.text()).toContain("\x1b[r"); // reset scroll region
    expect(term.text()).toContain("\x1b[?25h"); // show cursor
  });

  test("update and teardown are no-ops while inactive", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = new StatusBar(term);

    bar.update(INFO);
    bar.teardown();

    expect(term.writes).toHaveLength(0);
  });
});

describe("buildInputFrame", () => {
  test("draws the prompt on rows-2 and parks the cursor after the text", () => {
    const frame = buildInputFrame("hello", 5, 80, 24, false);

    expect(frame).toContain("\x1b[22;1H"); // input row (rows-2)
    expect(frame).toContain("\x1b[2K"); // clear the row
    expect(frame).toContain("› hello");
    // prompt is 2 cols, cursor at index 5 ⇒ column 2 + 5 + 1 = 8
    expect(frame.endsWith("\x1b[22;8H")).toBe(true);
  });

  test("parks the cursor at the prompt on an empty line", () => {
    const frame = buildInputFrame("", 0, 80, 24, false);

    // column 2 + 0 + 1 = 3 (just after the 2-col prompt)
    expect(frame.endsWith("\x1b[22;3H")).toBe(true);
  });

  test("horizontally scrolls a line wider than the viewport, keeping the cursor visible", () => {
    const line = "abcdefghij".repeat(10); // 100 chars
    const frame = buildInputFrame(line, line.length, 20, 24, false);
    const avail = 20 - 2;

    // Only a viewport-sized window is shown, not the whole line.
    expect(frame).not.toContain(line);
    // Cursor stays within the row (never runs past the right edge). Match without
    // the ESC byte so the regex carries no control character.
    const match = /\[22;(\d+)H$/.exec(frame);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(2 + avail);
  });
});

describe("StatusBar with input row", () => {
  const withInput = (term: FakeTerm): StatusBar =>
    new StatusBar(term, true, false, true);

  test("reserves THREE bottom rows and saves the stream cursor", () => {
    const term = new FakeTerm(true, 24, 80);

    withInput(term).install(INFO);

    expect(term.text()).toContain("\x1b[1;21r"); // region = rows-3 (24-3)
    expect(term.text()).toContain("\x1b7"); // stream cursor saved for writeStream
    expect(term.text()).toContain("\x1b[22;1H"); // input row painted (rows-2)
    expect(term.text()).toContain("\x1b[24;1H"); // segments row still on row 24
  });

  test("writeStream restores into the region, writes, re-saves, repaints the row", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setInput("typed", 5);
    term.writes.length = 0;
    bar.writeStream("agent output\n");

    const out = term.text();
    const order = [
      out.indexOf("\x1b8"), // restore stream cursor (into region)
      out.indexOf("agent output"), // the streamed text
      out.lastIndexOf("\x1b7"), // re-save advanced stream cursor
      out.indexOf("\x1b[22;1H"), // repaint input row afterwards
    ];

    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly ordered
    expect(out).toContain("› typed"); // the typed buffer survives the stream
  });

  test("a plain write falls back when not installed (non-TTY / small term)", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = withInput(term);

    bar.writeStream("hi"); // never installed
    expect(term.text()).toBe("hi");
  });

  test("update repaints the bar body without clobbering the stream-cursor slot", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    term.writes.length = 0;
    bar.update(INFO);

    const out = term.text();

    // Must NOT wrap in save/restore (that slot holds the stream cursor); it ends
    // by parking on the input row instead.
    expect(out.startsWith("\x1b7")).toBe(false);
    expect(out).toContain("\x1b[24;1H"); // segments repainted
    expect(out).toContain("\x1b[22;1H"); // input row repainted last
  });

  test("teardown after a shrink below the reserved height emits no row index < 1", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term); // reserves 3 rows

    bar.install(INFO);
    term.rows = 2; // resized smaller than `reserved` before teardown
    term.writes.length = 0;
    bar.teardown();

    // Every cursor-position sequence must target a 1-indexed (>= 1) row.
    for (const match of term.text().matchAll(/\[(-?\d+);1H/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(1);
    }
  });

  test("resize after a shrink below the reserved height emits no row index < 1", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term); // reserves 3 rows

    bar.install(INFO);
    term.rows = 1; // shrunk below `reserved` (3) after install
    term.writes.length = 0;
    bar.resize(INFO);

    const out = term.text();

    // The scroll-region end (`[1;Nr`) must stay >= 1 (never `[1;-2r`).
    for (const match of out.matchAll(/\[1;(-?\d+)r/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(1);
    }

    // Every cursor-position sequence must target a 1-indexed (>= 1) row.
    for (const match of out.matchAll(/\[(-?\d+);1H/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(1);
    }
  });

  test("teardown clears all THREE reserved rows", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    term.writes.length = 0;
    bar.teardown();

    const out = term.text();

    expect(out).toContain("\x1b[r"); // reset scroll region
    expect(out).toContain("\x1b[22;1H"); // input row cleared
    expect(out).toContain("\x1b[23;1H"); // border row cleared
    expect(out).toContain("\x1b[24;1H"); // segments row cleared
    expect(out).toContain("\x1b[?25h"); // show cursor
  });
});

describe("buildOverlayFrame (@-picker dropdown)", () => {
  test("paints rows bottom-aligned directly above the input row", () => {
    // rows=24 ⇒ input row is 22; a 2-line popup sits on rows 20 and 21.
    const frame = buildOverlayFrame(["a.ts", "b.ts"], 0, 24);

    expect(frame).toContain("\x1b[20;1H\x1b[2Ka.ts");
    expect(frame).toContain("\x1b[21;1H\x1b[2Kb.ts");
    expect(frame).not.toContain("\x1b[22;1H"); // never touches the input row
  });

  test("a shrunk list clears the old top rows above the new ones", () => {
    // Was 3 rows tall, now 1 ⇒ still operate over 3 rows; top 2 are cleared blank.
    const frame = buildOverlayFrame(["only.ts"], 3, 24);

    expect(frame).toContain("\x1b[19;1H\x1b[2K"); // cleared (old) row, no content
    expect(frame).toContain("\x1b[20;1H\x1b[2K");
    expect(frame).toContain("\x1b[21;1H\x1b[2Konly.ts"); // new row, bottom-aligned
  });

  test("clamps so it never addresses above row 1 on a short terminal", () => {
    const frame = buildOverlayFrame(["x", "y", "z"], 0, 5); // input row = 3

    expect(frame).not.toContain("\x1b[0;1H"); // never row 0 / negative
    expect(frame).not.toContain("\x1b[-1;1H");
    expect(frame).toContain("\x1b[1;1H"); // clamped to row 1
  });
});

describe("buildEditorFrame", () => {
  test("clears and renders each editor line, then parks the cursor", () => {
    const frame = buildEditorFrame(
      ["line one", "line two"],
      1,
      3,
      80,
      24,
      false
    );

    // Two editor lines: one per line, all cleared first
    expect(frame).toContain("\x1b[20;1H\x1b[2Kline one");
    expect(frame).toContain("\x1b[21;1H\x1b[2Kline two");
    // Cursor parked at blockStart + cursorRow = 20 + 1 = 21, cursorCol + 1 = 3 + 1 = 4
    expect(frame.endsWith("\x1b[21;4H")).toBe(true);
  });

  test("renders all provided lines (caller must clamp beforehand)", () => {
    // buildEditorFrame renders whatever lines are passed; the caller (setEditor)
    // handles clamping. This tests that it renders all of them.
    const lines = Array(5).fill("line");
    const frame = buildEditorFrame(lines, 0, 0, 80, 24, false);

    const lineMatches = frame.match(/line/g);

    expect(lineMatches).toHaveLength(5);
  });

  test("parks cursor at blockStart + cursorRow, cursorCol + 1", () => {
    const frame = buildEditorFrame(
      ["first", "second", "third"],
      2,
      5,
      80,
      24,
      false
    );

    // blockStart = max(1, 22 - 3) = 19; cursor at 19 + 2 = 21, col 5 + 1 = 6
    expect(frame.endsWith("\x1b[21;6H")).toBe(true);
  });

  test("clamps block start to row 1 on a small terminal", () => {
    // On a 5-row terminal: inputRow = max(1, 5 - 2) = 3
    // blockStart = max(1, 3 - 1) = 2 (if 1 line); never goes to row 0 or negative
    const frame = buildEditorFrame(["only"], 0, 0, 80, 5, false);

    expect(frame).not.toContain("\x1b[0;1H");
    expect(frame).not.toContain("\x1b[-1;1H");
    expect(frame).toContain("\x1b[2;1H"); // blockStart clamped
  });
});

describe("StatusBar with multi-row editor", () => {
  const withInput = (term: FakeTerm): StatusBar =>
    new StatusBar(term, true, false, true);

  test("setEditor renders and parks the cursor (input mode only)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    term.writes.length = 0;
    bar.setEditor(["first line", "second line"], 1, 4);

    const out = term.text();

    expect(out).toContain("first line");
    expect(out).toContain("second line");
    // blockStart = 24 - 2 - 2 = 20; cursor at 20 + 1 = 21, col 4 + 1 = 5
    expect(out.endsWith("\x1b[21;5H")).toBe(true);
  });

  test("setEditor is a no-op when not installed (non-TTY)", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = withInput(term);

    bar.setEditor(["hi"], 0, 0);
    expect(term.writes).toHaveLength(0);
  });

  test("setEditor clamps lines to available rows above input row", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    term.writes.length = 0;

    // Try to set 50 lines, but only 21 rows available (24 - 2 input/bar rows - 1 for safety)
    const manyLines = Array(50).fill("line");

    bar.setEditor(manyLines, 0, 0);

    const out = term.text();
    const lineMatches = out.match(/line/g);

    expect((lineMatches?.length ?? 0) <= 21).toBe(true);
  });

  test("setEditor shrinking a block clears old top rows (no ghost rows)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);

    // First: render a 4-row block
    const fourLines = ["line 1", "line 2", "line 3", "line 4"];

    bar.setEditor(fourLines, 3, 0);
    term.writes.length = 0;

    // Second: shrink to 1 row — the old rows 18-21 must be explicitly cleared
    // buildEditorFrame will clear max(4, 1) = 4 rows starting at blockStart
    bar.setEditor(["only line"], 0, 0);

    const out = term.text();

    // buildEditorFrame clears rows for max(previous, current) = max(4, 1) = 4 rows
    // blockStart = max(1, 22 - 4) = 18
    // So all 4 rows (18-21) are processed: row 18 gets "only line", rows 19-21 are cleared
    expect(out).toContain("\x1b[18;1H\x1b[2Konly line"); // row 18 with content
    expect(out).toContain("\x1b[19;1H\x1b[2K"); // row 19 cleared (no content)
    expect(out).toContain("\x1b[20;1H\x1b[2K"); // row 20 cleared (no content)
    expect(out).toContain("\x1b[21;1H\x1b[2K"); // row 21 cleared (no content)
    // The key assertion: we've cleared the high-water-mark, so no stale text remains
    // Count clear sequences (position + erase line) to verify all 4 rows are cleared
    const clearCount = (out.match(/\[(\d+);1H.*?\[2K/g) ?? []).length;

    expect(clearCount).toBeGreaterThanOrEqual(4);
  });

  test("setEditor adjusts scroll region when height changes (pinned editor block)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    // Initial scroll region: rows 1-21 (reserved = 3: bar + input = 2 + 1)
    // Expect: \x1b[1;21r
    expect(term.text()).toContain("\x1b[1;21r");

    term.writes.length = 0;

    // Set a 2-row editor block
    bar.setEditor(["line 1", "line 2"], 0, 0);

    const out = term.text();

    // Scroll region must shrink to rows 1-19 (reserved=3 + editor=2)
    // New regionEnd = 24 - 3 - 2 = 19
    expect(out).toContain("\x1b[1;19r");

    term.writes.length = 0;

    // Shrink editor to 1 row
    bar.setEditor(["only"], 0, 0);

    const out2 = term.text();

    // Scroll region expands back to rows 1-20 (reserved=3 + editor=1)
    // New regionEnd = 24 - 3 - 1 = 20
    expect(out2).toContain("\x1b[1;20r");
  });

  test("setEditor clamps editor height so scroll region stays >= 1 row", () => {
    const term = new FakeTerm(true, 5, 80);
    const bar = withInput(term);

    bar.install(INFO);
    // On a 5-row terminal: reserved=3, so input row is at row 3
    // maxRows for editor = max(0, 3 - 1) = 2
    // But if we requested 50, it clamps to 2

    const many = Array(50).fill("line");

    bar.setEditor(many, 0, 0);

    const out = term.text();

    // Editor height should be clamped to 2 rows
    // regionEnd = 5 - 3 - 2 = 0 → clamped to max(1, 0) = 1
    // So scroll region is \x1b[1;1r (just 1 row for streaming)
    expect(out).toContain("\x1b[1;1r");
  });

  test("resize after editor block adjust updates scroll region correctly", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["line 1", "line 2", "line 3"], 0, 0);
    // regionEnd = 24 - 3 - 3 = 18
    expect(term.text()).toContain("\x1b[1;18r");

    term.rows = 30; // resize taller
    term.writes.length = 0;
    bar.resize(INFO);

    const out = term.text();

    // After resize: regionEnd = 30 - 3 - 3 = 24
    expect(out).toContain("\x1b[1;24r");
  });

  test("teardown resets scroll region and clears editor block height", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["line 1", "line 2"], 0, 0);
    term.writes.length = 0;
    bar.teardown();

    const out = term.text();

    // Scroll region reset to full screen
    expect(out).toContain("\x1b[r");
    // Editor block height should be cleared for next activate
    expect(bar.active).toBe(false);
  });
});

describe("StatusBar @-picker overlay", () => {
  test("setOverlay paints the popup, then clearOverlay erases it", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false, true); // withInput

    bar.install(INFO);
    bar.setInput("explain @", 9);
    term.writes.length = 0;

    bar.setOverlay(["src/a.ts", "src/b.ts"], INFO);
    expect(term.text()).toContain("src/a.ts");
    expect(term.text()).toContain("\x1b[21;1H"); // popup row above the input row (22)

    term.writes.length = 0;
    bar.clearOverlay(INFO);
    expect(term.text()).toContain("\x1b[20;1H\x1b[2K"); // old popup rows erased
    expect(term.text()).toContain("\x1b[21;1H\x1b[2K");
  });

  test("setOverlay is a no-op without an input row (no inline surface)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false, false); // no input row

    bar.install(INFO);
    term.writes.length = 0;
    bar.setOverlay(["a.ts"], INFO);

    expect(term.writes).toHaveLength(0);
  });
});
