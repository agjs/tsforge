import { describe, expect, test } from "bun:test";
import {
  startEditor,
  type IEditorHandle,
  type IStdin,
} from "../src/editor/controller";
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
  turns: 1,
  elapsedMs: 0,
  status: "idle",
  scope: "src/**",
  tokensPerSecond: 0,
};

/** Captures every emitted byte, exposed as IStatusBarTerminal for StatusBar. */
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

/** EventEmitter-like stdin stub; tests feed bytes synchronously. */
class FakeStdin implements IStdin {
  private readonly listeners = new Set<(data: string) => void>();

  on(event: string, callback: (data: string) => void): void {
    if (event === "data") {
      this.listeners.add(callback);
    }
  }

  removeListener(event: string, callback: (data: string) => void): void {
    if (event === "data") {
      this.listeners.delete(callback);
    }
  }

  setRawMode(): void {
    // no-op
  }

  resume(): void {
    // no-op
  }

  setEncoding(): void {
    // no-op
  }

  feed(chunk: string): void {
    for (const cb of this.listeners) {
      cb(chunk);
    }
  }
}

interface IHarness {
  stdin: FakeStdin;
  handle: IEditorHandle;
  term: FakeTerm;
  bar: StatusBar;
  /** Render the full captured byte stream onto a fresh grid and return it. */
  screen(): VirtualScreen;
}

/**
 * Wire the REAL editor controller to a REAL StatusBar over a FakeTerm, exactly
 * as cli.ts does (out → writeStream, renderEditor → setEditor, withInput=true).
 * This exercises the production render path end-to-end: keystrokes in, terminal
 * bytes out, screen grid asserted.
 */
function buildHarness(rows = 24, columns = 80): IHarness {
  const term = new FakeTerm(true, rows, columns);
  const bar = new StatusBar(term, true, false, true);
  const stdin = new FakeStdin();

  const handle = startEditor({
    stdin,
    out: (s: string) => {
      bar.writeStream(s);
    },
    renderEditor: (lines: string[], cursorRow: number, cursorCol: number) => {
      bar.setEditor(lines, cursorRow, cursorCol);
    },
    columns,
    rows,
  });

  // cli.ts installs the bar immediately after wiring the editor.
  bar.install(INFO);

  return {
    stdin,
    handle,
    term,
    bar,
    screen: () => {
      const s = new VirtualScreen(rows, columns);

      s.feed(term.text());

      return s;
    },
  };
}

describe("editor e2e — rendered screen (VirtualScreen)", () => {
  test("typing a single line shows it once above the prompt", () => {
    const h = buildHarness();

    h.stdin.feed("test123");

    expect(h.screen().rowsContaining("test123")).toBe(1);
  });

  test("GHOST REPRO: type, 3× newline, delete back to one line → one row only", () => {
    const h = buildHarness();

    h.stdin.feed("test123");
    h.stdin.feed("\x1b\r"); // Alt/Option+Enter — newline, no submit
    h.stdin.feed("\x1b\r");
    h.stdin.feed("\x1b\r");
    // Buffer is now "test123\n\n\n" (4 logical lines). Remove the 3 blanks.
    h.stdin.feed("\x7f");
    h.stdin.feed("\x7f");
    h.stdin.feed("\x7f");

    // The user typed test123 once; it must appear on exactly one row.
    expect(h.screen().rowsContaining("test123")).toBe(1);
  });

  test("growing then shrinking the block leaves no stale rows", () => {
    const h = buildHarness();

    h.stdin.feed("alpha");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("beta");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("gamma");

    const before = h.screen();

    expect(before.rowsContaining("alpha")).toBe(1);
    expect(before.rowsContaining("beta")).toBe(1);
    expect(before.rowsContaining("gamma")).toBe(1);

    // Delete gamma + its newline + beta + its newline → just "alpha".
    const deletes = "gamma".length + 1 + "beta".length + 1;

    for (let i = 0; i < deletes; i += 1) {
      h.stdin.feed("\x7f");
    }

    const after = h.screen();

    expect(after.rowsContaining("alpha")).toBe(1);
    expect(after.rowsContaining("beta")).toBe(0);
    expect(after.rowsContaining("gamma")).toBe(0);
  });

  test("submitting clears the editor block (no leftover text on screen)", () => {
    const h = buildHarness();

    h.stdin.feed("hello world");
    expect(h.screen().rowsContaining("hello world")).toBe(1);

    h.stdin.feed("\r"); // submit

    expect(h.screen().rowsContaining("hello world")).toBe(0);
  });

  test("submitting a multi-line message clears every row", () => {
    const h = buildHarness();

    h.stdin.feed("one");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("two");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("three");
    expect(h.screen().rowsContaining("two")).toBe(1);

    h.stdin.feed("\r"); // submit

    const after = h.screen();

    expect(after.rowsContaining("one")).toBe(0);
    expect(after.rowsContaining("two")).toBe(0);
    expect(after.rowsContaining("three")).toBe(0);
  });

  test("a multi-line paste renders one row per line, no ghosts", () => {
    const h = buildHarness();

    h.stdin.feed("\x1b[200~apple\rbanana\rcherry\x1b[201~");

    const screen = h.screen();

    expect(screen.rowsContaining("apple")).toBe(1);
    expect(screen.rowsContaining("banana")).toBe(1);
    expect(screen.rowsContaining("cherry")).toBe(1);
  });

  test("agent output streams ABOVE the editor; the typed line survives", () => {
    const h = buildHarness();

    h.stdin.feed("my prompt");
    // Simulate the agent streaming output between keystrokes.
    h.bar.writeStream("agent line A\n");
    h.bar.writeStream("agent line B\n");

    const screen = h.screen();

    // The editor content is untouched by streaming...
    expect(screen.rowsContaining("my prompt")).toBe(1);
    // ...and the streamed lines landed on the screen above it.
    expect(screen.rowsContaining("agent line A")).toBe(1);
    expect(screen.rowsContaining("agent line B")).toBe(1);

    const promptRow = findRow(screen, "my prompt");
    const streamRow = findRow(screen, "agent line B");

    expect(streamRow).toBeLessThan(promptRow); // stream is above the editor
  });

  test("a line longer than the terminal width wraps without dropping text", () => {
    const h = buildHarness(24, 20); // narrow terminal

    const long = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars > 20 cols

    h.stdin.feed(long);

    const screen = h.screen();
    const joined = screen.text().replace(/\n/g, "");

    expect(joined).toContain(long); // every character survives across wrapped rows
  });

  test("history recall shows the prior message exactly once", () => {
    const h = buildHarness();

    h.stdin.feed("first message");
    h.stdin.feed("\r");
    h.stdin.feed("second message");
    h.stdin.feed("\r");

    // Both submitted; editor is empty.
    expect(h.screen().rowsContaining("second message")).toBe(0);

    h.stdin.feed("\x1b[A"); // up arrow → recall most recent

    const screen = h.screen();

    expect(screen.rowsContaining("second message")).toBe(1);
    expect(screen.rowsContaining("first message")).toBe(0);
  });

  test("backspace at line start joins lines with no ghost of the split form", () => {
    const h = buildHarness();

    h.stdin.feed("foo");
    h.stdin.feed("\x1b\r"); // newline → foo\n
    h.stdin.feed("bar"); // foo\nbar, cursor after bar
    h.stdin.feed("\x1b[H"); // home → start of "bar" line
    h.stdin.feed("\x7f"); // backspace joins → "foobar"

    const screen = h.screen();

    expect(h.handle.getBuffer().getText()).toBe("foobar");
    expect(screen.rowsContaining("foobar")).toBe(1);
    // The previous 2-row form must not linger.
    expect(screen.rowsContaining("bar")).toBe(1); // only inside "foobar"
  });

  test("editing mid-line re-renders the whole line correctly", () => {
    const h = buildHarness();

    h.stdin.feed("helo");
    h.stdin.feed("\x1b[D"); // left (before 'o')
    h.stdin.feed("\x1b[D"); // left (before 'l')
    h.stdin.feed("l"); // insert → "hello"

    const screen = h.screen();

    expect(h.handle.getBuffer().getText()).toBe("hello");
    expect(screen.rowsContaining("hello")).toBe(1);
    expect(screen.rowsContaining("helo")).toBe(0);
  });
});

/** First 1-based row index whose text contains `needle` (0 if absent). */
function findRow(screen: VirtualScreen, needle: string): number {
  for (let r = 1; r <= 24; r += 1) {
    if (screen.row(r).includes(needle)) {
      return r;
    }
  }

  return 0;
}

describe("editor e2e — aggressive interaction probes", () => {
  test("streaming while a MULTI-LINE block is up preserves every editor row", () => {
    const h = buildHarness();

    h.stdin.feed("line one");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("line two");
    h.stdin.feed("\x1b\r");
    h.stdin.feed("line three");

    h.bar.writeStream("STREAMED OUTPUT\n");

    const screen = h.screen();

    expect(screen.rowsContaining("line one")).toBe(1);
    expect(screen.rowsContaining("line two")).toBe(1);
    expect(screen.rowsContaining("line three")).toBe(1);
    expect(screen.rowsContaining("STREAMED OUTPUT")).toBe(1);
  });

  test("typing more after a stream appends without duplicating", () => {
    const h = buildHarness();

    h.stdin.feed("abc");
    h.bar.writeStream("noise\n");
    h.stdin.feed("def");

    const screen = h.screen();

    expect(h.handle.getBuffer().getText()).toBe("abcdef");
    expect(screen.rowsContaining("abcdef")).toBe(1);
  });

  test("resizing the terminal mid-edit re-renders content once", () => {
    const h = buildHarness(24, 80);

    h.stdin.feed("resize me");
    h.term.rows = 30;
    h.bar.resize(INFO);
    h.stdin.feed("!"); // force a repaint at the new size

    const screen = new VirtualScreen(30, 80);

    screen.feed(h.term.text());
    expect(screen.rowsContaining("resize me!")).toBe(1);
  });

  test("a block taller than the terminal never crashes or writes above row 1", () => {
    const h = buildHarness(10, 40); // small terminal: ~7 usable rows

    for (let i = 0; i < 20; i += 1) {
      h.stdin.feed(`row${i}`);
      h.stdin.feed("\x1b\r");
    }

    h.stdin.feed("last");

    const screen = h.screen();

    // The most recent content stays visible (cursor line is always shown).
    expect(screen.rowsContaining("last")).toBe(1);
    // Nothing escaped above the top row or into negative rows.
    const esc = String.fromCharCode(27);

    expect(h.term.text()).not.toContain(`${esc}[0;`);
    expect(h.term.text()).not.toContain(`${esc}[-`);
  });

  test("the cursor lands on the cell just after the typed text", () => {
    const h = buildHarness();

    h.stdin.feed("hi");

    const { row, col } = h.screen().cursorPosition();

    // inputRow = 22, single line bottom-anchored at row 21, cursor after "hi".
    expect(row).toBe(21);
    expect(col).toBe(3); // 1-based: after 2 graphemes
  });

  test("cursor tracks a left-arrow move to mid-line", () => {
    const h = buildHarness();

    h.stdin.feed("hello");
    h.stdin.feed("\x1b[D"); // left
    h.stdin.feed("\x1b[D"); // left → between 'l' and 'l'

    const { col } = h.screen().cursorPosition();

    expect(col).toBe(4); // after "hel"
  });

  test("emoji (multi-byte grapheme) renders and does not duplicate", () => {
    const h = buildHarness();

    h.stdin.feed("hi 👋 there");

    const screen = h.screen();

    expect(screen.rowsContaining("there")).toBe(1);
    expect(h.handle.getBuffer().getText()).toBe("hi 👋 there");
  });

  test("ctrl+u kills to line start, leaving no ghost of the killed text", () => {
    const h = buildHarness();

    h.stdin.feed("delete all of this");
    h.stdin.feed("\x15"); // ctrl+u

    const screen = h.screen();

    expect(h.handle.getBuffer().getText()).toBe("");
    expect(screen.rowsContaining("delete all of this")).toBe(0);
  });
});

describe("editor e2e — non-ASCII input (regression: keys dropped >= 0x7f)", () => {
  test("accented Latin and CJK text is accepted and rendered", () => {
    const h = buildHarness();

    h.stdin.feed("café 日本語 ñ");

    expect(h.handle.getBuffer().getText()).toBe("café 日本語 ñ");
    expect(h.screen().rowsContaining("café")).toBe(1);
  });

  test("a non-ASCII paste keeps every character", () => {
    const h = buildHarness();

    h.stdin.feed("\x1b[200~Grüße — 你好 👍\x1b[201~");

    expect(h.handle.getBuffer().getText()).toBe("Grüße — 你好 👍");
  });
});
