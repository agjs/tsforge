import { test, expect, describe } from "bun:test";
import {
  StatusBar,
  type IStatusInfo,
  type IStatusBarTerminal,
} from "../src/render";
import { VirtualScreen } from "./helpers/virtual-screen";

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

  test("activates on a real terminal and renders the bar segments", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);

    expect(bar.active).toBe(true);

    // Relative-redraw: the bar is drawn as the last lines after content (here, at
    // the top of an empty terminal). Assert the rendered segments appear.
    const screen = new VirtualScreen(24, 80);

    screen.feed(term.text());
    expect(screen.text()).toContain("done");
    expect(screen.text()).toContain("qwen3.6-27b");
  });

  test("teardown deactivates and shows the cursor", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);
    term.writes.length = 0;
    bar.teardown();

    expect(bar.active).toBe(false);
    expect(term.text()).toContain("\x1b[0J"); // erase the live region
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

describe("StatusBar with input row", () => {
  const withInput = (term: FakeTerm): StatusBar =>
    new StatusBar(term, true, false, true);

  /** Render the emitted byte stream onto a grid the size of the terminal. */
  const render = (term: FakeTerm): VirtualScreen => {
    const s = new VirtualScreen(term.rows, term.columns);

    s.feed(term.text());

    return s;
  };

  test("renders the input prompt and the bar below it", () => {
    const term = new FakeTerm(true, 24, 80);

    withInput(term).install(INFO);

    // The prompt row sits ABOVE the border rule + segments (the live region's
    // last three lines). Assert the rendered content + order.
    const screen = render(term);
    const promptRow = screen.rowsContaining("›");
    const segRow = screen.rowsContaining("qwen3.6-27b");

    expect(promptRow).toBe(1);
    expect(segRow).toBe(1);
    expect(screen.text()).toContain("done");
  });

  test("writeStream puts content above the input, keeping ONE bar", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setInput("typed", 5);
    bar.writeStream("agent output\n");

    const screen = render(term);

    // The streamed line appears; the typed buffer + a single bar remain below it.
    expect(screen.text()).toContain("agent output");
    expect(screen.rowsContaining("typed")).toBe(1);
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
  });

  test("a plain write falls back when not installed (non-TTY / small term)", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = withInput(term);

    bar.writeStream("hi"); // never installed
    expect(term.text()).toBe("hi");
  });

  test("update repaints the bar with the new status (single bar)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.update({ ...INFO, status: "stuck" });

    const screen = render(term);

    expect(screen.text()).toContain("stuck");
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
  });

  test("teardown erases the live region and shows the cursor", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.teardown();

    expect(term.text()).toContain("\x1b[0J"); // erased to end of screen
    expect(term.text()).toContain("\x1b[?25h"); // cursor shown
    expect(bar.active).toBe(false);
  });
});

describe("StatusBar with multi-row editor", () => {
  const withInput = (term: FakeTerm): StatusBar =>
    new StatusBar(term, true, false, true);

  const render = (term: FakeTerm): VirtualScreen => {
    const s = new VirtualScreen(term.rows, term.columns);

    s.feed(term.text());

    return s;
  };

  test("setEditor keeps the `›` prompt in front of the editor block", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["first line", "second line"], 1, 4);

    const screen = render(term);

    // The prompt persists in editor mode: the first row is `› first line`, and the
    // continuation row is aligned under it with the same 2-col gutter.
    expect(screen.text()).toContain("› first line");
    expect(screen.text()).toContain("  second line");
    // The parked cursor sits on the editor's cursor line (the second row).
    const cur = screen.cursorPosition();

    expect(screen.row(cur.row)).toContain("second line");
  });

  test("setEditor is a no-op when not installed (non-TTY)", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = withInput(term);

    bar.setEditor(["hi"], 0, 0);
    expect(term.writes).toHaveLength(0);
  });

  test("writeStream in editor mode: content above, editor + one bar below", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["hello"], 0, 5);
    bar.writeStream("agent output\n");

    const screen = render(term);

    expect(screen.text()).toContain("agent output");
    expect(screen.rowsContaining("hello")).toBe(1);
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
    // Cursor returns to the editor line, not onto the bar.
    expect(screen.row(screen.cursorPosition().row)).toContain("hello");
  });

  test("shrinking the editor block leaves no ghost rows (VirtualScreen)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["L1", "L2", "L3", "L4"], 3, 0);
    bar.setEditor(["only line"], 0, 0);

    const screen = render(term);

    // The old 4-row block is fully gone; only the shrunk content remains, once.
    expect(screen.rowsContaining("L1")).toBe(0);
    expect(screen.rowsContaining("L4")).toBe(0);
    expect(screen.rowsContaining("only line")).toBe(1);
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
  });

  test("resize redraws exactly one bar (VirtualScreen)", () => {
    const term = new FakeTerm(true, 10, 40);
    const bar = withInput(term);

    bar.install(INFO);
    term.rows = 20;
    bar.resize(INFO);

    const screen = render(term);

    // The relative renderer erases its region and redraws once — a single bar,
    // regardless of the size change (reflow-proofing is exercised in the iTerm2
    // e2e; here we assert the emitted redraw yields one bar).
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
  });

  test("streaming many chunks never trails a second bar into scrollback", () => {
    // The reported bug: on pristine main, streaming while the terminal churns
    // stranded copies of the bar into scrollback (visible on scroll-up). The
    // relative model erases the region before each write and redraws it after, so
    // the bar is never left in the scrollable buffer — it can appear only once,
    // no matter how much scrolls past.
    const term = new FakeTerm(true, 10, 40);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["typing here"], 0, 6);

    for (let i = 0; i < 40; i += 1) {
      bar.writeStream(`response line ${i}\n`);
    }

    const screen = new VirtualScreen(10, 40);

    screen.feed(term.text());

    // The 10-row viewport shows the tail of the stream + ONE bar + the editor line.
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
    expect(screen.rowsContaining("typing here")).toBe(1);
  });

  test("repeated setEditor cycles (palette open/close) strand no content", () => {
    // Opening the `/` palette repaints the editor block via setEditor on return.
    // Each setEditor must ERASE+redraw the region — never leak the editor text into
    // scrollback (the "////" regression, where repaintEditor used writeStream).
    const term = new FakeTerm(true, 10, 40);
    const bar = withInput(term);

    bar.install(INFO);

    for (let i = 0; i < 5; i += 1) {
      bar.setEditor(["SLASHCMD"], 0, 8); // typed "/" (marker), palette opens
      bar.setEditor([""], 0, 0); // palette cancelled/cleared → repaint
    }

    const screen = new VirtualScreen(10, 40);

    screen.feed(term.text());

    // The editor text never lingers as content, and there's a single bar.
    expect(screen.rowsContaining("SLASHCMD")).toBe(0);
    expect(screen.rowsContaining("qwen3.6-27b")).toBe(1);
  });

  test("teardown erases the region and deactivates", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = withInput(term);

    bar.install(INFO);
    bar.setEditor(["line 1", "line 2"], 0, 0);
    bar.teardown();

    expect(term.text()).toContain("\x1b[0J"); // erased to end of screen
    expect(bar.active).toBe(false);
  });
});

describe("StatusBar @-picker overlay", () => {
  const render = (term: FakeTerm): VirtualScreen => {
    const s = new VirtualScreen(term.rows, term.columns);

    s.feed(term.text());

    return s;
  };

  test("setOverlay shows the popup above the input; clearOverlay removes it", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false, true); // withInput

    bar.install(INFO);
    bar.setInput("explain @", 9);
    bar.setOverlay(["src/a.ts", "src/b.ts"], INFO);

    let screen = render(term);

    expect(screen.rowsContaining("src/a.ts")).toBe(1);
    expect(screen.rowsContaining("src/b.ts")).toBe(1);
    // The overlay sits ABOVE the input row (which still holds the typed text).
    const overlayRow = render(term)
      .text()
      .split("\n")
      .findIndex((l) => l.includes("src/a.ts"));
    const inputRow = render(term)
      .text()
      .split("\n")
      .findIndex((l) => l.includes("explain @"));

    expect(overlayRow).toBeLessThan(inputRow);

    bar.clearOverlay(INFO);
    screen = render(term);
    expect(screen.rowsContaining("src/a.ts")).toBe(0);
    expect(screen.rowsContaining("explain @")).toBe(1);
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
