import { describe, expect, test } from "bun:test";
import { startEditor } from "../src/editor/controller";
import type { IEditorCompletionSource } from "../src/editor/controller";
import { StatusBar } from "../src/render";
import type { IStatusInfo } from "../src/render";
import { filterFiles, formatCompletionRows } from "../src/render/file-menu";
import { VirtualScreen } from "./helpers/virtual-screen";

/**
 * TRUE end-to-end render test: wire the real editor controller to the real
 * StatusBar exactly as cli.ts does (editor's renderEditor callback → setEditor,
 * out → writeStream), feed real keystrokes through the stdin stub, then replay
 * every emitted byte into a VirtualScreen and assert where the TEXT and the
 * CURSOR actually land. This catches the "text one row above the cursor" desync
 * that escape-string assertions miss — no live terminal needed.
 */

const ROWS = 24;
const COLS = 80;

const INFO: IStatusInfo = {
  model: "model",
  contextTokens: 0,
  contextWindow: 1000,
  turns: 0,
  elapsedMs: 0,
  status: "ready",
  scope: "workspace",
};

class FakeTerm {
  readonly writes: string[] = [];
  readonly isTTY = true;

  constructor(
    public rows = ROWS,
    public columns = COLS
  ) {}

  write(data: string): boolean {
    this.writes.push(data);

    return true;
  }

  text(): string {
    return this.writes.join("");
  }
}

class FakeStdin {
  private readonly dataCbs = new Set<(d: string) => void>();

  on(event: string, cb: (d: string) => void): void {
    if (event === "data") {
      this.dataCbs.add(cb);
    }
  }

  removeListener(event: string, cb: (d: string) => void): void {
    if (event === "data") {
      this.dataCbs.delete(cb);
    }
  }

  setRawMode(): void {}
  resume(): void {}
  setEncoding(): void {}

  feed(s: string): void {
    this.dataCbs.forEach((cb) => {
      cb(s);
    });
  }
}

const FILES = ["src/lexer.ts", "src/parser.ts", "src/query.ts"];

function harness(withCompletion = false) {
  const term = new FakeTerm();
  const bar = new StatusBar(term, true, false, true);

  bar.install(INFO);

  // Mirrors cli.ts's editor-native completion source (filter a list, paint the
  // dropdown above the block via setEditorOverlay).
  const completion: IEditorCompletionSource = {
    items: (query: string) => filterFiles(FILES, query),
    render: (items, selected) => {
      bar.setEditorOverlay(formatCompletionRows(items, selected, COLS, true));
    },
    clear: () => {
      bar.clearEditorOverlay();
    },
  };

  const stdin = new FakeStdin();
  const handle = startEditor({
    stdin,
    out: (s: string) => {
      bar.writeStream(s);
    },
    renderEditor: (lines, cursorRow, cursorCol) => {
      bar.setEditor(lines, cursorRow, cursorCol);
    },
    columns: COLS,
    rows: ROWS,
    completion: withCompletion ? completion : undefined,
  });

  const render = (): VirtualScreen => {
    const screen = new VirtualScreen(ROWS, COLS);

    screen.feed(term.text());

    return screen;
  };

  return { term, bar, stdin, handle, render };
}

describe("editor render e2e (real controller + StatusBar)", () => {
  test("typing does NOT move the text off the cursor's home row (the reported bug)", () => {
    const { stdin, render } = harness();

    // The cursor's home BEFORE any typing (where it blinks at the prompt).
    const homeRow = render().cursorPosition().row;

    stdin.feed("dsad");

    const screen = render();
    const cur = screen.cursorPosition();

    // The bug was: text rendered one row ABOVE where the cursor was sitting. The
    // invariant the old tests missed — text must land on the cursor's home row.
    expect(cur.row).toBe(homeRow);
    expect(screen.row(cur.row)).toContain("dsad");
    // Cursor rests just past the 4 typed chars.
    expect(cur.col).toBe(5);
    // The text appears exactly once (no ghost copy on another row).
    expect(screen.rowsContaining("dsad")).toBe(1);
  });

  test("multi-line: the cursor lands on the second line's text", () => {
    const { stdin, render } = harness();

    stdin.feed("aa");
    stdin.feed("\x1b[13;2u"); // Kitty Shift+Enter → newline, no submit
    stdin.feed("bb");

    const screen = render();
    const cur = screen.cursorPosition();

    expect(screen.row(cur.row)).toContain("bb");
    expect(screen.rowsContaining("aa")).toBe(1);
    expect(screen.rowsContaining("bb")).toBe(1);
  });

  test("streamed agent output uses CRLF (no staircase) and stays above the input", () => {
    const { stdin, bar, render } = harness();

    stdin.feed("howdy");
    // The agent streams a multi-line response (interactiveStream → writeStream).
    bar.writeStream("Line one.\n");
    bar.writeStream("Line two.\n");

    const screen = render();
    const cur = screen.cursorPosition();

    const rowOf = (needle: string): number => {
      for (let r = 1; r <= ROWS; r += 1) {
        if (screen.row(r).includes(needle)) {
          return r;
        }
      }

      return -1;
    };

    // The input is intact on the cursor's row, untouched by the stream.
    expect(screen.row(cur.row)).toContain("howdy");
    // Each streamed line begins at column 1 — raw-mode `\n` without CR would have
    // staircased line two rightward (leading spaces). row() trims only the tail,
    // so an exact match proves no leading indent.
    expect(screen.row(rowOf("Line two."))).toBe("Line two.");
    // The whole stream sits ABOVE the input row (separated, not merged).
    expect(rowOf("Line one.")).toBeLessThan(cur.row);
    expect(rowOf("Line two.")).toBeLessThan(cur.row);
  });

  test("a bar repaint (spinner tick) between tokens does not drop the response onto the input", () => {
    const { stdin, bar, render } = harness();

    stdin.feed("howdy");
    // The real run ticks the spinner (bar.update) between streamed tokens. The
    // terminal's single cursor-save slot is shared by writeStream's stream cursor
    // and the bar repaint; if update() clobbers it, later tokens land on the input
    // row and the response is lost. Interleave them to prove it doesn't.
    bar.writeStream("Hey there. ");
    bar.update(INFO);
    bar.writeStream("What can I ");
    bar.update(INFO);
    bar.writeStream("help with?");
    bar.update(INFO);

    const screen = render();
    const cur = screen.cursorPosition();

    const rowOf = (needle: string): number => {
      for (let r = 1; r <= ROWS; r += 1) {
        if (screen.row(r).includes(needle)) {
          return r;
        }
      }

      return -1;
    };

    // The WHOLE response survived, assembled on one row ABOVE the input — not
    // truncated to the first token, not written onto the input row.
    const responseRow = rowOf("Hey there. What can I help with?");

    expect(responseRow).toBeGreaterThan(0);
    expect(responseRow).toBeLessThan(cur.row);
    // The input is untouched.
    expect(screen.row(cur.row)).toContain("howdy");
  });
});

describe("editor render e2e — @ completion", () => {
  test("typing `@` opens the dropdown ABOVE the block; the editor text/cursor stay put", () => {
    const { stdin, render } = harness(true);

    const homeRow = render().cursorPosition().row;

    stdin.feed("@");

    const screen = render();
    const cur = screen.cursorPosition();

    // The `@` stays on the cursor's home row — the cursor does NOT jump.
    expect(cur.row).toBe(homeRow);
    expect(screen.row(homeRow)).toContain("@");
    // The dropdown lists files on rows ABOVE the editor block (not on its row).
    expect(screen.row(homeRow)).not.toContain("lexer");
    const aboveHasFiles = [homeRow - 1, homeRow - 2, homeRow - 3].some((r) =>
      screen.row(r).includes("lexer")
    );

    expect(aboveHasFiles).toBe(true);
  });

  test("pressing `@` after existing text does NOT move that text to another row (the bug)", () => {
    const { stdin, render } = harness(true);

    stdin.feed("hello "); // type some text first
    const homeRow = render().cursorPosition().row;

    stdin.feed("@"); // open completion at the word boundary

    const screen = render();

    // The pre-existing text stays on its row exactly once — no shoving to a line above.
    expect(screen.rowsContaining("hello")).toBe(1);
    expect(screen.row(homeRow)).toContain("hello @");
    expect(screen.cursorPosition().row).toBe(homeRow);
  });

  test("typing filters, then Enter accepts the highlighted file as `@<path> `", () => {
    const { stdin, handle } = harness(true);

    stdin.feed("@");
    stdin.feed("lex"); // filters to src/lexer.ts
    stdin.feed("\r"); // accept

    // Buffer holds the at-mention: `@` + path + trailing space.
    const [first] = filterFiles(FILES, "lex");
    const expected = `@${first ?? ""} `;

    expect(handle.getBuffer().getText()).toBe(expected);
  });

  test("arrow-down then Enter accepts the second candidate", () => {
    const { stdin, handle } = harness(true);

    stdin.feed("@");
    stdin.feed("\x1b[B"); // down → select index 1
    stdin.feed("\r");

    const second = filterFiles(FILES, "")[1];
    const expected = `@${second ?? ""} `;

    expect(handle.getBuffer().getText()).toBe(expected);
  });

  test("Esc closes the dropdown and keeps the typed text", () => {
    const { stdin, handle, render } = harness(true);

    stdin.feed("@lex");
    stdin.feed("\x1b"); // escape

    // Text preserved; dropdown gone (no file rows left on screen).
    expect(handle.getBuffer().getText()).toBe("@lex");

    const screen = render();

    expect(screen.rowsContaining("parser")).toBe(0);
  });

  test("backspacing past the `@` closes the dropdown", () => {
    const { stdin, render } = harness(true);

    stdin.feed("@");
    stdin.feed("\x7f"); // backspace removes the `@`

    const screen = render();

    expect(screen.rowsContaining("lexer")).toBe(0);
  });
});
