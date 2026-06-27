/**
 * VirtualScreen — a headless ANSI/VT100 terminal emulator for tests.
 *
 * The render code emits escape sequences (cursor moves, line erases, a DECSTBM
 * scroll region, save/restore cursor). Asserting on those raw sequences proves
 * we *sent* the right bytes in isolation, but it cannot catch emergent bugs —
 * ghost rows, scroll duplication, mis-cleared blocks — because those only exist
 * in the *grid of cells a terminal renders* after applying a whole stream.
 *
 * VirtualScreen applies the same byte stream a real terminal would receive
 * (captured via the FakeTerm double) onto a 2-D cell grid, so tests assert on
 * the *visible screen* — the equivalent of a screenshot — deterministically and
 * in-process. It implements the subset of VT100 the render layer uses:
 *   - CUP            ESC [ row ; col H   (absolute cursor)
 *   - EL             ESC [ n K           (erase line: 0 to-end, 1 to-start, 2 all)
 *   - ED             ESC [ n J           (erase display)
 *   - DECSTBM        ESC [ top ; bot r   (scroll region; homes the cursor)
 *   - DECSC / DECRC  ESC 7 / ESC 8       (save / restore cursor)
 *   - CUU/CUD/CUF/CUB ESC [ n A/B/C/D    (relative cursor moves)
 *   - LF / CR / BS, and printable text with autowrap + region-aware scrolling.
 * SGR (colour) and DEC-private / other CSI sequences (bracketed paste, Kitty,
 * modifyOtherKeys) are parsed and ignored — they don't change the cell grid.
 */

const ESC = "\x1b";

interface ICursor {
  row: number;
  col: number;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const n = Number.parseInt(value, 10);

  return Number.isNaN(n) ? fallback : n;
}

export class VirtualScreen {
  private readonly grid: string[][];
  private cursor: ICursor = { row: 1, col: 1 };
  private saved: ICursor = { row: 1, col: 1 };
  private scrollTop = 1;
  private scrollBottom: number;

  constructor(
    private readonly rows: number,
    private readonly cols: number
  ) {
    this.scrollBottom = rows;
    this.grid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => " ")
    );
  }

  /** Apply a chunk of terminal output to the grid. */
  feed(data: string): void {
    let i = 0;

    while (i < data.length) {
      const ch = data[i] ?? "";

      if (ch === ESC) {
        i = this.handleEscape(data, i);

        continue;
      }

      this.handlePlain(ch);
      i += 1;
    }
  }

  /** The text on a 1-based row, right-trimmed. */
  row(n: number): string {
    const line = this.grid[n - 1];

    if (line === undefined) {
      return "";
    }

    return line.join("").replace(/\s+$/, "");
  }

  /** All rows, right-trimmed, with trailing blank rows removed. */
  text(): string {
    const lines = this.grid.map((_, idx) => this.row(idx + 1));

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  /** How many rows contain `needle` as a substring. Ghost detection: a string
   *  the user typed once should appear on exactly one row. */
  rowsContaining(needle: string): number {
    return this.grid.reduce((count, _, idx) => {
      return this.row(idx + 1).includes(needle) ? count + 1 : count;
    }, 0);
  }

  /** The 1-based cursor position after the stream was applied. */
  cursorPosition(): ICursor {
    return { row: this.cursor.row, col: this.cursor.col };
  }

  // --- escape handling -------------------------------------------------------

  private handleEscape(data: string, start: number): number {
    const next = data[start + 1];

    if (next === "7") {
      this.saved = { row: this.cursor.row, col: this.cursor.col };

      return start + 2;
    }

    if (next === "8") {
      this.cursor = { row: this.saved.row, col: this.saved.col };

      return start + 2;
    }

    if (next === "[") {
      return this.handleCsi(data, start + 2);
    }

    // Unknown 2-byte escape — skip both bytes.
    return start + 2;
  }

  private handleCsi(data: string, paramStart: number): number {
    let j = paramStart;
    let prefix = "";
    const first = data[j] ?? "";

    if (first === "?" || first === ">" || first === "<") {
      prefix = first;
      j += 1;
    }

    let params = "";

    while (j < data.length) {
      const c = data[j] ?? "";

      if ((c >= "0" && c <= "9") || c === ";") {
        params += c;
        j += 1;
      } else {
        break;
      }
    }

    const final = data[j] ?? "";

    // DEC-private (?...) and other-prefix (>,<) sequences don't touch the grid.
    if (prefix === "") {
      this.applyCsi(final, params);
    }

    return j + 1;
  }

  private applyCsi(final: string, params: string): void {
    const parts = params.split(";");

    if (final === "H" || final === "f") {
      this.setCursor(toInt(parts[0], 1), toInt(parts[1], 1));
    } else if (final === "r") {
      this.setScrollRegion(params, parts);
    } else if (final === "K") {
      this.eraseLine(toInt(parts[0], 0));
    } else if (final === "J") {
      this.eraseDisplay(toInt(parts[0], 0));
    } else {
      this.applyCursorMove(final, toInt(parts[0], 1));
    }
    // Any other final byte (e.g. "m" SGR) is intentionally ignored.
  }

  private applyCursorMove(final: string, n: number): void {
    if (final === "A") {
      this.setCursor(this.cursor.row - n, this.cursor.col);
    } else if (final === "B") {
      this.setCursor(this.cursor.row + n, this.cursor.col);
    } else if (final === "C") {
      this.setCursor(this.cursor.row, this.cursor.col + n);
    } else if (final === "D") {
      this.setCursor(this.cursor.row, this.cursor.col - n);
    }
  }

  private setScrollRegion(params: string, parts: string[]): void {
    if (params === "") {
      this.scrollTop = 1;
      this.scrollBottom = this.rows;
    } else {
      this.scrollTop = toInt(parts[0], 1);
      this.scrollBottom = toInt(parts[1], this.rows);
    }

    // DECSTBM homes the cursor.
    this.setCursor(1, 1);
  }

  private eraseLine(mode: number): void {
    const line = this.grid[this.cursor.row - 1];

    if (line === undefined) {
      return;
    }

    const from = mode === 0 ? this.cursor.col - 1 : 0;
    const to = mode === 1 ? this.cursor.col : this.cols;

    for (let c = from; c < to && c < this.cols; c += 1) {
      line[c] = " ";
    }
  }

  private eraseDisplay(mode: number): void {
    // mode 2 (and 3) clear the whole screen; 0/1 partials are unused by the
    // render layer, so treat any erase-display as a full clear for our needs.
    if (mode === 2 || mode === 3) {
      for (const line of this.grid) {
        line.fill(" ");
      }
    }
  }

  // --- plain bytes -----------------------------------------------------------

  private handlePlain(ch: string): void {
    if (ch === "\n") {
      this.lineFeed();
    } else if (ch === "\r") {
      this.cursor.col = 1;
    } else if (ch === "\b") {
      this.cursor.col = Math.max(1, this.cursor.col - 1);
    } else if (ch >= " ") {
      this.putChar(ch);
    }
    // Other control bytes are ignored.
  }

  private putChar(ch: string): void {
    if (this.cursor.col > this.cols) {
      this.cursor.col = 1;
      this.lineFeed();
    }

    const line = this.grid[this.cursor.row - 1];

    if (line !== undefined) {
      line[this.cursor.col - 1] = ch;
    }

    this.cursor.col += 1;
  }

  private lineFeed(): void {
    if (this.cursor.row === this.scrollBottom) {
      this.scrollUp();
    } else if (this.cursor.row < this.rows) {
      this.cursor.row += 1;
    }
  }

  private scrollUp(): void {
    for (let r = this.scrollTop; r < this.scrollBottom; r += 1) {
      const below = this.grid[r];

      if (below !== undefined) {
        this.grid[r - 1] = below.slice();
      }
    }

    const bottom = this.grid[this.scrollBottom - 1];

    if (bottom !== undefined) {
      bottom.fill(" ");
    }
  }

  private setCursor(row: number, col: number): void {
    this.cursor.row = Math.min(Math.max(1, row), this.rows);
    this.cursor.col = Math.min(Math.max(1, col), this.cols);
  }
}
