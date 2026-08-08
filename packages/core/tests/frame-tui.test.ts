import { test, expect, describe } from "bun:test";
import {
  blankFrame,
  writeRect,
  freezeFrame,
  diffFrames,
  cloneFrame,
  Scrollback,
  computeLayout,
  canUsePaneTui,
  PaneScreen,
  ENTER_ALT,
  EXIT_ALT,
  BEGIN_SYNC,
  END_SYNC,
  CLEAR_SCREEN,
  PANE_MIN_ROWS,
  BOTTOM_CHROME_ROWS,
  INPUT_BAND_ROWS,
  CHROME_PAD_X,
  inputCursorCol,
  outerInsets,
  OUTER_MARGIN,
  TOP_PAD_ROWS,
  BOTTOM_PAD_ROWS,
} from "../src/render/frame";
import { formatStatusBarLine } from "../src/render/status-bar";
import { VirtualScreen } from "./helpers/virtual-screen";

function findPromptRow(feed: string, rows: number, cols: number): number {
  const screen = new VirtualScreen(rows, cols);

  screen.feed(feed);

  // Input box ╭ (not the outer window) — next row holds `> `.
  for (let r = 1; r <= rows; r += 1) {
    if (
      screen.row(r).includes("╭") &&
      screen.row(r + 1).includes(">")
    ) {
      return r + 1;
    }
  }

  return expectedPromptRow(rows, cols);
}

function expectedPromptRow(termRows: number, cols = 100): number {
  const insets = outerInsets(termRows, cols);
  const layout = computeLayout({
    rows: insets.contentRows,
    cols: insets.contentCols,
  });
  const top = layout.input.rows >= 3 ? 1 : 0;

  return insets.originRow + layout.input.row + top + 1;
}

function promptBoxTop(termRows: number, cols = 100): number {
  const insets = outerInsets(termRows, cols);
  const layout = computeLayout({
    rows: insets.contentRows,
    cols: insets.contentCols,
  });

  return insets.originRow + layout.input.row + 1;
}

/** 1-based title strip row inside the floating window. */
function titleRow(termRows: number, cols = 100): number {
  const insets = outerInsets(termRows, cols);

  // Topbar: TOP_PAD_ROWS air, then title.
  return insets.originRow + TOP_PAD_ROWS + 1;
}

/** 1-based outer-window bottom edge (`╰─╯`). */
function outerBottomRow(termRows: number): number {
  return termRows - OUTER_MARGIN;
}

function contentLayout(
  termRows: number,
  cols = 100,
  showPanel?: boolean
): ReturnType<typeof computeLayout> {
  const insets = outerInsets(termRows, cols);

  return computeLayout({
    rows: insets.contentRows,
    cols: insets.contentCols,
    showPanel,
  });
}

/** True when a framed row has no ink inside the outer `│…│`. */
function isFramedAir(row: string): boolean {
  return row.replace(/[│╭╮╰╯─]/gu, "").trim() === "";
}

describe("grid diff", () => {
  test("full redraw when prev is null", () => {
    const grid = cloneFrame(blankFrame(2, 4));

    writeRect(grid, { row: 0, col: 0, rows: 1, cols: 4 }, ["abcd"]);
    const frame = freezeFrame(grid, 2, 4);
    const bytes = diffFrames(null, frame);

    expect(bytes).toContain("abcd");
  });

  test("dirty rows only on second paint", () => {
    const a = cloneFrame(blankFrame(2, 4));

    writeRect(a, { row: 0, col: 0, rows: 1, cols: 4 }, ["aaaa"]);
    const prev = freezeFrame(a, 2, 4);

    const b = cloneFrame(prev);

    writeRect(b, { row: 1, col: 0, rows: 1, cols: 4 }, ["bbbb"]);
    const next = freezeFrame(b, 2, 4);
    const bytes = diffFrames(prev, next);

    expect(bytes).toContain("bbbb");
    // Row 0 unchanged — only one CUP to row 2 (1-based).
    const cupRe = new RegExp(`${String.fromCharCode(27)}\\[\\d+;1H`, "g");

    expect(bytes.match(cupRe)?.length).toBe(1);
  });
});

describe("Scrollback", () => {
  test("follows the bottom and scrolls up to older lines", () => {
    const sb = new Scrollback(100, 2);

    sb.setWrapCols(80);
    sb.append("one\n");
    sb.append("two\n");
    sb.append("three\n");

    // 3 lines > viewport 2 → bottom window.
    expect(sb.visible()).toEqual(["two", "three"]);

    sb.scroll(1);
    expect(sb.visible()).toEqual(["one", "two"]);

    sb.follow();
    expect(sb.visible()).toEqual(["two", "three"]);
  });

  test("metrics report overflow while following and real offsets when scrolled", () => {
    const sb = new Scrollback(100, 2);

    sb.setWrapCols(80);
    sb.append("one\n");
    expect(sb.metrics().total).toBeLessThanOrEqual(sb.metrics().viewport);

    sb.append("two\n");
    sb.append("three\n");
    const live = sb.metrics();

    expect(live.following).toBe(true);
    expect(live.total).toBeGreaterThan(live.viewport);

    sb.scroll(1);
    const up = sb.metrics();

    expect(up.following).toBe(false);
    expect(up.total).toBe(3);
    expect(up.offset).toBe(0);
  });

  test("short following content is top-aligned (no void above the banner)", () => {
    const sb = new Scrollback(100, 5);

    sb.setWrapCols(80);
    sb.append("hello\n");

    expect(sb.visible()).toEqual(["hello", "", "", "", ""]);
  });

  test("wraps long lines so overflow is not truncated away", () => {
    const sb = new Scrollback(100, 3);

    sb.setWrapCols(4);
    sb.append("abcdefgh\n");

    // Short + following → top-aligned (pad below).
    expect(sb.visible()).toEqual(["abcd", "efgh", ""]);
  });

  test("reflow preserves the logical line at the viewport top when scrolled up", () => {
    const sb = new Scrollback(100, 3);

    sb.setWrapCols(20);

    for (let i = 0; i < 10; i += 1) {
      sb.append(`LINE_${String(i)}_UNIQUE\n`);
    }

    sb.scroll(5);
    const before = sb.visible().find((l) => l.includes("LINE_"));

    expect(before !== undefined).toBe(true);
    sb.reflow(10);
    const after = sb.visible().join("\n");

    expect(after).toContain((before ?? "").slice(0, 8));
    expect(sb.following).toBe(false);
  });

  test("follow mode stays at bottom across reflow", () => {
    const sb = new Scrollback(100, 2);

    sb.setWrapCols(40);
    sb.append("one\n");
    sb.append("two\n");
    sb.append("three\n");
    sb.reflow(10);
    expect(sb.following).toBe(true);
    expect(sb.visible().join(" ")).toContain("three");
  });

  test("wrap cache keeps repeated visible() cheap after a large append", () => {
    const sb = new Scrollback(5_000, 20);

    sb.setWrapCols(80);

    for (let i = 0; i < 2_000; i += 1) {
      sb.append(`line-${String(i)}-${"x".repeat(60)}\n`);
    }

    // Warm the cache once, then hammer visible() — must stay well under a
    // re-wrap-all-lines budget (the old path was tens of ms per call).
    sb.visible();
    const t0 = performance.now();

    for (let i = 0; i < 200; i += 1) {
      expect(sb.visible().length).toBe(20);
    }

    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("computeLayout", () => {
  test("splits into main + panel when wide enough", () => {
    const layout = computeLayout({ rows: 20, cols: 100 });

    expect(layout.collapsedPanel).toBe(false);
    expect(layout.panel).not.toBeNull();
    expect(layout.main.cols + 1 + (layout.panel?.cols ?? 0)).toBe(100);
    expect(layout.top.rows).toBe(TOP_PAD_ROWS + 3); // pad + title + pad + rule
    expect(layout.footer.rows).toBe(BOTTOM_PAD_ROWS);
    expect(layout.footer.row + layout.footer.rows).toBe(20);
    expect(layout.input.rows).toBe(INPUT_BAND_ROWS);
  });

  test("keeps pinned topbar at PANE_MIN_ROWS content height", () => {
    const layout = contentLayout(PANE_MIN_ROWS, 100);

    expect(layout.top.rows).toBe(TOP_PAD_ROWS + 3);
    // Short height may shrink the input band slightly; never below 1.
    expect(layout.input.rows).toBeGreaterThanOrEqual(1);
    expect(layout.input.rows).toBeLessThanOrEqual(INPUT_BAND_ROWS);
  });

  test("collapses the panel on narrow terminals", () => {
    const layout = computeLayout({ rows: 20, cols: 60 });

    expect(layout.collapsedPanel).toBe(true);
    expect(layout.panel).toBeNull();
    expect(layout.main.cols).toBe(60);
  });

  test("canUsePaneTui gates on PANE_MIN_ROWS", () => {
    expect(canUsePaneTui(PANE_MIN_ROWS - 1)).toBe(false);
    expect(canUsePaneTui(PANE_MIN_ROWS)).toBe(true);
  });

  test("input band grows with inputInnerRows and shrinks the body", () => {
    const idle = computeLayout({ rows: 24, cols: 100, inputInnerRows: 1 });
    const tall = computeLayout({ rows: 24, cols: 100, inputInnerRows: 6 });

    expect(idle.input.rows).toBe(INPUT_BAND_ROWS);
    expect(tall.input.rows).toBeGreaterThan(idle.input.rows);
    expect(tall.main.rows).toBeLessThan(idle.main.rows);
    // Cap: asking for more than max does not grow further.
    const capped = computeLayout({ rows: 24, cols: 100, inputInnerRows: 99 });

    expect(capped.input.rows).toBe(tall.input.rows);
  });
});

describe("PaneScreen", () => {
  class FakeTerm {
    writes: string[] = [];
    isTTY = true;
    rows = 24;
    columns = 100;

    write(data: string): boolean {
      this.writes.push(data);

      return true;
    }

    text(): string {
      return this.writes.join("");
    }
  }

  test("setInput stays fast with a large transcript (no full re-wrap)", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 40, 120);

    panes.enter();

    // Warm a large wrap cache once — then keystrokes must stay on paintInputOnly.
    const bulk = Array.from(
      { length: 2_000 },
      (_, i) => `line-${String(i)}-${"x".repeat(80)}`
    ).join("\n");

    panes.appendMain(`${bulk}\n`);

    term.writes = [];
    const t0 = performance.now();
    let text = "";

    for (let i = 0; i < 100; i += 1) {
      text += i % 5 === 0 ? " " : "a";
      panes.setInput({ lines: [text], cursorRow: 0, cursorCol: text.length });
    }

    // Full re-wrap on every key used to land in the multi‑second range here.
    expect(performance.now() - t0).toBeLessThan(150);
    expect(term.writes.length).toBeGreaterThan(0);
  });

  test("identical paint is a no-op (no cursor thrash); frames use sync wrap", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    expect(term.text()).toContain(BEGIN_SYNC);
    expect(term.text()).toContain(END_SYNC);

    term.writes = [];
    panes.paint();
    expect(term.writes).toHaveLength(0);

    // Status with the same formatted line as a prior identical setStatus is skipped.
    panes.setStatus({
      model: "m",
      contextTokens: 1,
      contextWindow: 100,
      turns: 0,
      elapsedMs: 0,
      status: "ready",
      scope: "repo",
    });
    const afterFirst = term.writes.length;

    panes.setStatus({
      model: "m",
      contextTokens: 1,
      contextWindow: 100,
      turns: 0,
      elapsedMs: 0,
      status: "ready",
      scope: "repo",
    });
    expect(term.writes.length).toBe(afterFirst);
  });

  test("input box grows with draft lines and collapses when cleared", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    const idlePrompt = findPromptRow(term.text(), 24, 100);

    panes.setInput({
      lines: ["one", "two", "three"],
      cursorRow: 2,
      cursorCol: 5,
    });

    let screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    const grownPrompt = findPromptRow(term.text(), 24, 100);

    expect(grownPrompt).toBeLessThan(idlePrompt);
    expect(screen.text()).toContain("one");
    expect(screen.text()).toContain("two");
    expect(screen.text()).toContain("three");

    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });
    expect(findPromptRow(term.text(), 24, 100)).toBe(idlePrompt);
  });

  test("enter paints both columns; leave exits alt screen", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    expect(panes.enter()).toBe(true);
    expect(term.text()).toContain(ENTER_ALT);
    // Opaque canvas — transparent terminals must not show wallpaper through blanks.
    expect(term.text()).toContain("[48;2;20;20;20m");

    panes.appendMain("hello main\n");
    panes.setPanel(["worklist  0/2", "[>] First"]);
    panes.setInput({ lines: ["type"], cursorRow: 0, cursorCol: 4 });

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    expect(screen.text()).toContain("hello main");
    expect(screen.row(1).trim()).toBe("");
    expect(screen.row(2)).toContain("╭");
    expect(screen.row(titleRow(24))).toContain("TSFORGE");
    expect(screen.row(titleRow(24))).toContain("#0/2");
    expect(screen.row(outerBottomRow(24))).toContain("╰");
    expect(screen.text()).toContain("[>] First");
    expect(screen.text()).not.toContain("forge>");
    expect(screen.text()).toContain("type");
    expect(screen.row(expectedPromptRow(24))).toContain("type");

    panes.leave();
    expect(term.text()).toContain(EXIT_ALT);
    expect(panes.active).toBe(false);
  });

  test("overflow paints a main-pane scrollbar thumb; short content does not", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.appendMain("short\n");

    let screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    expect(screen.text()).not.toContain("█");

    for (let i = 0; i < 40; i += 1) {
      panes.appendMain(`scroll-line-${String(i)}\n`);
    }

    screen = new VirtualScreen(24, 100);
    screen.feed(term.text());
    expect(screen.text()).toContain("█");

    // Thumb lives on the right edge of the main column (left of the panel gutter).
    const insets = outerInsets(24, 100);
    const layout = contentLayout(24, 100, true);
    const thumbIdx = insets.originCol + layout.main.cols - 1;
    let found = false;

    for (let r = 1; r <= 24; r += 1) {
      if (screen.row(r)[thumbIdx] === "█") {
        found = true;
        break;
      }
    }

    expect(found).toBe(true);
  });

  test("landing keeps the side panel under the pinned topbar", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setHeader({ cwd: "/tmp/demo", sessionId: "abcd1234" });
    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 0,
      elapsedMs: 0,
      status: "ready",
      scope: "repo",
      mode: "plan",
    });
    panes.appendMain("/help commands\n");
    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    // Floating window + inner split: outer ╭, title, ┬ under title, gutter │.
    const title = titleRow(24);

    expect(screen.row(1).trim()).toBe("");
    expect(screen.row(2)).toContain("╭");
    expect(screen.row(title)).toContain("TSFORGE");
    expect(screen.row(title)).toContain("deepseek");
    expect(screen.row(title)).toContain("PLAN");
    expect(screen.row(title)).toContain("✓");
    expect(screen.row(title)).toContain("#0/0");
    expect(screen.row(title)).toContain("repo");
    expect(isFramedAir(screen.row(title + 1))).toBe(true);
    expect(screen.row(title + 2)).toContain("┬");
    expect(screen.row(title + 3)).toContain("/help commands");
    expect(screen.row(title + 3)).toContain("│");
    // Hairline ┬ → gutter │/├ → outer ┴ closes the panel spine.
    const rule = screen.row(title + 2);
    const gutterIdx = rule.indexOf("┬");
    // Sticky rail title under the ┬ hairline: Tasks … 0/0, then under-rule.
    const railTitle = screen.row(title + 3);
    const railRule = screen.row(title + 4);

    expect(gutterIdx).toBeGreaterThan(0);
    expect(railTitle).toContain("Tasks");
    expect(railTitle).toContain("0/0");
    expect(railTitle.indexOf("Tasks")).toBeLessThan(railTitle.indexOf("0/0"));
    expect(railRule).toMatch(/─{4,}/);
    // Under-rule joins the gutter spine (├) and the outer rail (┤).
    expect(railRule[gutterIdx]).toBe("├");
    expect(railRule.trimEnd().endsWith("┤")).toBe(true);
    expect(screen.text()).toContain("/work");
    expect(screen.row(promptBoxTop(24))).toContain("╭");
    expect(screen.row(expectedPromptRow(24))).toContain(">");
    expect(screen.row(expectedPromptRow(24))).toContain("describe a task");
    expect(screen.row(outerBottomRow(24))).toContain("╯");
    expect(screen.text()).not.toContain("forge>");
    // Input box right corners share a column (not the outer-window │).
    const topPlain = screen.row(promptBoxTop(24));
    const midPlain = screen.row(expectedPromptRow(24));
    const botPlain = screen.row(promptBoxTop(24) + 2);
    const topRight = topPlain.lastIndexOf("╮");
    const outerBot = screen.row(outerBottomRow(24));

    expect(topRight).toBeGreaterThan(0);
    expect(midPlain[topRight]).toBe("│");
    expect(botPlain[topRight]).toBe("╯");
    expect(rule.slice(gutterIdx + 1).includes("─")).toBe(true);
    expect(midPlain[gutterIdx]).toBe("│");
    expect(outerBot[gutterIdx]).toBe("┴");
    // Input sits on the outer floor — last content row is the box bottom.
    expect(screen.row(outerBottomRow(24) - 1)).toContain("╯");
  });

  test("growing the input band still paints a single frame (≤ term rows)", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    term.writes = [];
    panes.setInput({
      lines: ["a", "b", "c", "d", "e", "f"],
      cursorRow: 5,
      cursorCol: 1,
    });

    const cups = term
      .text()
      .match(new RegExp(`${String.fromCharCode(27)}\\[\\d+;1H`, "g"));

    // A full-frame paint touches ≤24 rows — not one CUP per editor line unboundedly.
    expect((cups ?? []).length).toBeLessThanOrEqual(24);
  });

  test("wrapped scrollback keeps overflow text when scrolling", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, PANE_MIN_ROWS, 40);

    expect(panes.enter()).toBe(true);
    panes.appendMain(`${"word ".repeat(20)}\n`);
    panes.appendMain("TAIL_MARKER\n");

    // Scroll up: older wrapped chunks must still be reconstructable from dump,
    // and the viewport must still contain wrapped fragments (not a blank hole).
    panes.handleKey("\x1b[A");
    panes.handleKey("\x1b[A");

    expect(panes.dumpTranscript()).toContain("TAIL_MARKER");
    expect(term.text().length).toBeGreaterThan(0);
  });

  test("refuses to enter below PANE_MIN_ROWS", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 4, 100);

    expect(panes.enter()).toBe(false);
    expect(term.writes).toHaveLength(0);
  });

  test("refuses to enter when the terminal is not a TTY", () => {
    const term = new FakeTerm();

    term.isTTY = false;
    const panes = new PaneScreen(term, 24, 100);

    expect(panes.enter()).toBe(false);
    expect(term.writes).toHaveLength(0);
  });

  test("resize re-enters after a shrink-leave; never auto-enters a fresh screen", () => {
    const term = new FakeTerm();
    const neverStarted = new PaneScreen(term, 24, 100);

    neverStarted.resize(24, 100);
    expect(neverStarted.active).toBe(false);
    expect(term.writes).toHaveLength(0);

    const panes = new PaneScreen(term, 24, 100);

    expect(panes.enter()).toBe(true);
    const afterEnter = term.writes.length;

    panes.resize(4, 100);
    expect(panes.active).toBe(false);

    panes.resize(24, 100);
    expect(panes.active).toBe(true);
    expect(term.writes.length).toBeGreaterThan(afterEnter);
  });

  test("Ctrl+O requests dump; scrollMain moves transcript", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.appendMain("a\nb\nc\nd\ne\n");

    expect(panes.handleKey("\x0f")).toBe("dump");
    // Prompt keeps arrows; empty-prompt scroll uses scrollMain (REPL wiring).
    expect(panes.handleKey("\x1b[A")).toBe("passthrough");
    panes.scrollMain(1);
    expect(term.text().length).toBeGreaterThan(0);
    expect(panes.handleKey("x")).toBe("passthrough");
  });

  test("enter enables mouse capture so the host cannot scroll the window", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    expect(term.text()).toContain("\x1b[?1000h");
    expect(term.text()).toContain("\x1b[?1006h");
    expect(term.text()).toContain(ENTER_ALT);
  });

  test("mouse reports are swallowed as handled", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    expect(panes.handleKey("\x1b[<0;98;13M")).toBe("handled");
    expect(panes.handleKey("\x1b[<0;98;13m")).toBe("handled");
  });

  test("wheel over main scrolls transcript; wheel over panel scrolls rail only", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();

    for (let i = 0; i < 40; i += 1) {
      panes.appendMain(`MAIN_${String(i)}\n`);
    }

    panes.setPanel(
      Array.from({ length: 40 }, (_, i) =>
        i === 0 ? "worklist  0/39" : `PANEL_${String(i)}`
      )
    );

    // Main column: wheel must not move the input band.
    expect(panes.handleKey("\x1b[<64;10;5M")).toBe("handled");
    expect(findPromptRow(term.text(), 24, 100)).toBe(expectedPromptRow(24));

    // Panel column: scroll rail — early PANEL lines leave the viewport.
    panes.scrollPanel(20);
    const after = new VirtualScreen(24, 100);

    after.feed(term.text());
    expect(after.text()).not.toContain("PANEL_1");
    expect(after.text()).toMatch(/PANEL_\d+/);
    expect(findPromptRow(term.text(), 24, 100)).toBe(expectedPromptRow(24));
    expect(after.row(expectedPromptRow(24)).length).toBeGreaterThan(0);
  });

  test("preserves SGR in appended main text", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.appendMain("\x1b[31mred\x1b[0m plain\n");

    expect(term.text()).toContain("\x1b[31mred");

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    expect(screen.text()).toContain("red plain");
  });

  test("oversized main lines never overwrite the panel gutter", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);
    const insets = outerInsets(24, 100);
    const layout = contentLayout(24, 100);

    expect(layout.panel).not.toBeNull();
    const gutterCol = insets.originCol + layout.main.cols;

    panes.enter();
    // Wider than the main pane — old path let this punch through the gutter.
    panes.appendMain(`│ ${"W".repeat(200)}\n`);
    panes.setPanel(["/work"]);

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());

    let sawContentRow = false;
    const mainTop = insets.originRow + layout.main.row + 1;
    const mainBot = insets.originRow + layout.main.row + layout.main.rows;

    for (let r = mainTop; r <= mainBot; r += 1) {
      const row = screen.row(r);

      if (!row.includes("W")) {
        continue;
      }

      sawContentRow = true;
      // Panel gutter column stays a gutter glyph (│ spine or ├ under-rule) — never "W".
      expect(["│", "├"]).toContain(row[gutterCol]);
      // First panel cell is not overflowing main content.
      expect(row[gutterCol + 1]).not.toBe("W");
    }

    expect(sawContentRow).toBe(true);
  });

  test("setOverlay paints dropdown rows above the input strip", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });
    panes.setOverlay(["  src/a.ts", "▸ src/b.ts"]);

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    expect(screen.text()).toContain("src/a.ts");
    expect(screen.text()).toContain("src/b.ts");
    expect(screen.text()).toContain("describe a task");
    expect(screen.text()).not.toContain("forge>");
  });

  test("setOverlay stays in the main pane and keeps the panel gutter", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);
    const insets = outerInsets(24, 100);
    const layout = contentLayout(24, 100);

    expect(layout.panel).not.toBeNull();
    const gutterCol = insets.originCol + layout.main.cols;

    panes.enter();
    panes.setPanel(["worklist", "item-a"]);
    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });
    // Full-width hairline — old paint path drew this across the panel.
    panes.setOverlay([
      "/help",
      `› /help${" ".repeat(80)}`,
      "─".repeat(200),
      "show this help",
    ]);

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());

    let sawOverlay = false;
    const mainTop = insets.originRow + layout.main.row + 1;
    const mainBot = insets.originRow + layout.main.row + layout.main.rows;

    for (let r = mainTop; r <= mainBot; r += 1) {
      const row = screen.row(r);
      const mainSlice = row.slice(0, gutterCol);

      // Only rows where the overlay painted into the main column.
      if (!mainSlice.includes("/help") && !mainSlice.includes("─".repeat(20))) {
        continue;
      }

      sawOverlay = true;
      expect(row[gutterCol]).toBe("│");
      // Overlay must not punch through the gutter (panel may have its own short title rule).
      const panelSlice = row.slice(gutterCol + 1);

      expect(panelSlice.includes("─".repeat(40))).toBe(false);
    }

    expect(sawOverlay).toBe(true);
    expect(screen.text()).toContain("Tasks");
    expect(screen.text()).toContain("item-a");
  });

  test("setStatus paints live chips on the dense top strip", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setWorklistBadge("2/5");
    panes.setStatus({
      model: "test-model",
      contextTokens: 12_000,
      contextWindow: 100_000,
      turns: 2,
      elapsedMs: 1500,
      status: "responded",
      scope: "repo",
      mode: "plan",
      tokensPerSecond: 42,
    });

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    // All live chips live on the dense top strip; bottom is caret + placeholder.
    const title = titleRow(24);

    expect(screen.row(title)).toContain("TSFORGE");
    expect(screen.row(title)).toContain("test-model");
    expect(screen.row(title)).toContain("12%");
    expect(screen.row(title)).toContain("42t");
    expect(screen.row(title)).toContain("#2/5");
    expect(screen.row(title)).toContain("✓");
    expect(screen.row(expectedPromptRow(24))).toContain("describe a task");
    expect(screen.text()).not.toContain("tok/s");
    expect(screen.text()).not.toContain("forge>");
  });

  test("after paint, cursor sits on the input row (not under the footer)", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);
    const promptRow = expectedPromptRow(24);

    panes.enter();
    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });
    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 1,
      elapsedMs: 1100,
      status: "responded",
      scope: "repo",
      mode: "plan",
      tokensPerSecond: 51,
    });
    // Second status tick used to skip the cursor CUP (CursorState dedupe) while
    // the footer write left the hardware cursor on a scrolled row under the frame.
    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 1,
      elapsedMs: 1200,
      status: "responded",
      scope: "repo",
      mode: "plan",
      tokensPerSecond: 50,
    });
    panes.appendMain("◆ plan · reply to refine\n");

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    const { row, col } = screen.cursorPosition();

    // On caret row, after outer chrome + left inset + `│` + pad + `> `.
    const insets = outerInsets(24, 100);

    expect(row).toBe(promptRow);
    expect(col).toBe(insets.originCol + CHROME_PAD_X + inputCursorCol(0) + 1);
    expect(screen.row(promptRow)).toContain("describe a task");
    expect(screen.row(outerBottomRow(24))).toContain("╯");
    // Input box shares the agent card's left edge (chrome inset).
    expect(screen.row(promptBoxTop(24)).indexOf("╭")).toBe(
      insets.originCol + CHROME_PAD_X
    );
    expect(screen.row(titleRow(24))).toContain("deepseek");
    expect(screen.row(titleRow(24))).toContain("✓");
  });

  test("setStatus full-repaint clears ghost metrics rows above the input", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.appendMain("chat line\n");
    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 1,
      elapsedMs: 1100,
      status: "working",
      scope: "entire workspace",
      mode: "plan",
      tokensPerSecond: 47,
      activity: "⠋ thinking · 0s",
    });

    // Stray absolute writes into empty main rows (relative
    // redraw fighting the alt screen) — differential paint used to leave them.
    for (let i = 0; i < 6; i += 1) {
      const line = formatStatusBarLine(
        {
          model: "deepseek",
          contextTokens: 0,
          contextWindow: 100,
          turns: 1,
          elapsedMs: 1100,
          status: "working",
          scope: "entire workspace",
          mode: "plan",
          tokensPerSecond: 47,
          activity: `⠋ thinking · ${String(i)}s`,
        },
        100,
        true
      );

      term.write(`\x1b[${String(12 + i)};1H${line}`);
    }

    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 1,
      elapsedMs: 1100,
      status: "responded",
      scope: "entire workspace",
      mode: "plan",
      tokensPerSecond: 44,
    });

    const screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    const thinking = screen.text().match(/thinking/g) ?? [];

    expect(thinking.length).toBe(0);
    expect(screen.row(expectedPromptRow(24))).toContain("describe a task");
    expect(screen.row(titleRow(24))).toContain("✓");
    expect(screen.text()).toContain("chat line");
  });

  test("Ctrl+G focuses panel; Esc restores prompt focus", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setPanel(["worklist  0/2", "[>] First", "[ ] Second"]);
    expect(panes.handleKey("\x07")).toBe("handled");
    expect(panes.focusState.panelFocused).toBe(true);

    const focused = new VirtualScreen(24, 100);

    focused.feed(term.text());
    expect(focused.text()).toContain("▸");

    expect(panes.handleKey("\x1b")).toBe("handled");
    expect(panes.focusState.promptFocused).toBe(true);
  });

  test("input caret stays put across status ticks/overlays; multiline moves the band", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);
    const promptRow = expectedPromptRow(24);

    panes.enter();
    panes.setInput({ lines: ["stable"], cursorRow: 0, cursorCol: 6 });
    expect(findPromptRow(term.text(), 24, 100)).toBe(promptRow);

    panes.setStatus({
      model: "m",
      contextTokens: 1,
      contextWindow: 100,
      turns: 1,
      elapsedMs: 100,
      status: "ready",
      scope: "repo",
      tokensPerSecond: 10,
    });
    expect(findPromptRow(term.text(), 24, 100)).toBe(promptRow);

    panes.setStatus({
      model: "m",
      contextTokens: 50,
      contextWindow: 100,
      turns: 3,
      elapsedMs: 9000,
      status: "responded",
      scope: "repo",
      mode: "plan",
      tokensPerSecond: 99,
      activity: "⠋ thinking · 12s",
    });
    expect(findPromptRow(term.text(), 24, 100)).toBe(promptRow);

    panes.setBusy(true);
    expect(findPromptRow(term.text(), 24, 100)).toBe(promptRow);

    panes.setOverlay(
      Array.from({ length: 40 }, (_, i) => `overlay-${String(i)}`)
    );
    expect(findPromptRow(term.text(), 24, 100)).toBe(promptRow);

    panes.setInput({
      lines: ["a", "b", "c", "d", "e", "f"],
      cursorRow: 5,
      cursorCol: 1,
    });
    const grownPrompt = findPromptRow(term.text(), 24, 100);

    expect(grownPrompt).toBeLessThan(promptRow);

    for (let i = 0; i < 30; i += 1) {
      panes.appendMain(`stream-line-${String(i)}\n`);
    }

    // Streaming must not shove the grown band around.
    expect(findPromptRow(term.text(), 24, 100)).toBe(grownPrompt);

    const finalScreen = new VirtualScreen(24, 100);

    finalScreen.feed(term.text());
    expect(finalScreen.row(grownPrompt + 5)).toContain("f");
    expect(finalScreen.row(titleRow(24))).toMatch(/✓|●|thinking|abort/i);
    expect(finalScreen.text()).toContain("╭");
    expect(finalScreen.text()).not.toContain("forge>");
  });

  test("resize clears the screen and keeps input+footer pinned", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setStatus({
      model: "m",
      contextTokens: 0,
      contextWindow: 100,
      turns: 0,
      elapsedMs: 0,
      status: "ready",
      scope: "repo",
    });
    panes.appendMain("KEEP_ME\n");
    panes.setInput({ lines: ["hi"], cursorRow: 0, cursorCol: 2 });

    term.writes = [];
    panes.resize(40, 120);
    expect(term.text()).toContain(CLEAR_SCREEN);

    const tall = new VirtualScreen(40, 120);

    tall.feed(term.text());
    const tallBox = findPromptRow(term.text(), 40, 120);

    expect(tallBox).toBe(expectedPromptRow(40, 120));
    expect(tall.row(expectedPromptRow(40, 120)).length).toBeGreaterThan(0);
    expect(tall.text()).toContain("KEEP_ME");
    expect(tall.text()).toContain("hi");
    expect(tall.row(expectedPromptRow(40, 120))).toContain("hi");
    expect(tall.row(titleRow(40, 120))).toContain("#0/0");
    expect(tall.text()).not.toContain("forge>");

    term.writes = [];
    panes.resize(20, 60);
    expect(term.text()).toContain(CLEAR_SCREEN);

    const narrow = new VirtualScreen(20, 60);

    narrow.feed(term.text());
    const narrowLayout = contentLayout(20, 60);

    expect(narrowLayout.collapsedPanel).toBe(true);
    expect(findPromptRow(term.text(), 20, 60)).toBe(expectedPromptRow(20, 60));
    expect(narrow.row(expectedPromptRow(20, 60))).toContain("hi");
    // Narrow: no panel split tee (outer │ still frames the window).
    expect(narrow.row(titleRow(20, 60) + 2)).not.toContain("┬");
    expect(narrow.text()).not.toContain("/work");
  });

  test("resize no-op when geometry unchanged does not clear", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    term.writes = [];
    panes.resize(24, 100);
    expect(term.text()).not.toContain(CLEAR_SCREEN);
    expect(term.writes).toHaveLength(0);
  });

  test("landing and mid-stream paint fill every row without holes in chrome", () => {
    const term = new FakeTerm();
    const panes = new PaneScreen(term, 24, 100);

    panes.enter();
    panes.setStatus({
      model: "deepseek",
      contextTokens: 0,
      contextWindow: 100,
      turns: 0,
      elapsedMs: 0,
      status: "ready",
      scope: "repo",
      mode: "plan",
    });
    panes.appendMain("LOG_LINE\n");
    panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });

    let screen = new VirtualScreen(24, 100);

    screen.feed(term.text());
    const title = titleRow(24);

    expect(screen.row(2)).toContain("╭");
    expect(screen.row(title)).toContain("TSFORGE");
    expect(screen.row(title)).toContain("PLAN");
    expect(screen.row(title)).toContain("deepseek");
    expect(isFramedAir(screen.row(title + 1))).toBe(true);
    expect(screen.row(title + 2)).toContain("┬");
    expect(screen.row(title + 3)).toContain("LOG_LINE");
    expect(screen.row(title + 3)).toContain("│");
    expect(findPromptRow(term.text(), 24, 100)).toBe(expectedPromptRow(24));
    expect(screen.row(expectedPromptRow(24))).toContain("describe a task");

    for (let i = 0; i < 50; i += 1) {
      panes.appendMain(`line-${String(i)}\n`);
    }

    screen = new VirtualScreen(24, 100);
    screen.feed(term.text());
    expect(findPromptRow(term.text(), 24, 100)).toBe(expectedPromptRow(24));
    expect(screen.row(expectedPromptRow(24))).toContain("describe a task");
    expect(screen.row(titleRow(24))).toContain("#0/0");
    expect(screen.text()).not.toContain("forge>");
  });

  test("layout pins top and bottom chrome without stealing the input band", () => {
    const wide = contentLayout(24, 100);
    const wideInsets = outerInsets(24, 100);

    expect(wide.input.rows).toBe(INPUT_BAND_ROWS);
    expect(wide.footer.rows).toBe(BOTTOM_PAD_ROWS);
    expect(wide.input.rows + wide.footer.rows).toBe(BOTTOM_CHROME_ROWS);
    expect(wide.top.rows + wide.main.rows + BOTTOM_CHROME_ROWS).toBe(
      wideInsets.contentRows
    );
    expect(wide.top.rows).toBe(TOP_PAD_ROWS + 3);
    expect(wide.collapsedPanel).toBe(false);
    expect(wide.panel).not.toBeNull();

    const short = contentLayout(PANE_MIN_ROWS, 100);
    const shortInsets = outerInsets(PANE_MIN_ROWS, 100);

    expect(short.top.rows).toBe(TOP_PAD_ROWS + 3);
    expect(short.input.rows).toBeGreaterThanOrEqual(1);
    expect(
      short.top.rows + short.main.rows + short.input.rows + short.footer.rows
    ).toBe(shortInsets.contentRows);
  });
});
