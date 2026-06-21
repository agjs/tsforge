import { test, expect, describe } from "bun:test";
import {
  StatusBar,
  buildBarFrame,
  buildInputFrame,
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
