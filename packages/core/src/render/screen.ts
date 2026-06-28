import { displayWidth, graphemes } from "./width";

/**
 * A double-buffered virtual screen with damage tracking — the idea OpenTUI's
 * native core is built on, here in plain TypeScript and scoped to the bottom
 * pinned region. The status bar previously repainted every pinned row with
 * `ESC[2K` + a full rewrite on every state change (a token tick, a keystroke),
 * which flickers and ships bytes for cells that did not change.
 *
 * `ScreenBuffer` sits in front of the existing frame builders: you hand it the
 * ANSI frame they already produce, it interprets that frame onto a cell grid,
 * diffs the grid against what is currently on screen, and emits ONLY the changed
 * cells (plus a final cursor park). Same pixels, far fewer bytes, no flicker.
 *
 * It interprets the subset of VT100 the render layer emits — CUP (`ESC[r;cH`),
 * EL (`ESC[nK`), SGR colour (`ESC[…m`, captured per cell), and printable text
 * with display-width awareness. Structural sequences the bar emits directly
 * (the DECSTBM scroll region, cursor save/restore) never pass through here.
 */

const ESC = "\x1b";
const RESET_SGR = `${ESC}[0m`;

/** One terminal cell. `ch === " "` is blank; `ch === ""` is the right half of a
 *  preceding wide (2-column) cell and is never emitted on its own. */
interface ICell {
  ch: string;
  sgr: string;
}

interface ICursor {
  row: number;
  col: number;
}

const blank = (): ICell => ({ ch: " ", sgr: "" });

function blankGrid(rows: number, cols: number): ICell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, blank)
  );
}

function cloneGrid(grid: ICell[][]): ICell[][] {
  return grid.map((row) => row.map((cell) => ({ ch: cell.ch, sgr: cell.sgr })));
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const n = Number.parseInt(value, 10);

  return Number.isNaN(n) ? fallback : n;
}

/** Applies one ANSI frame onto a grid, tracking the cursor and the active SGR so
 *  every written cell records the colour it was painted with. */
class FrameApplier {
  cursor: ICursor = { row: 1, col: 1 };
  private sgr = "";

  constructor(
    private readonly grid: ICell[][],
    private readonly rows: number,
    private readonly cols: number
  ) {}

  apply(frame: string): void {
    let i = 0;

    while (i < frame.length) {
      const ch = frame[i] ?? "";

      if (ch === ESC) {
        i = frame[i + 1] === "[" ? this.csi(frame, i + 2) : i + 2;

        continue;
      }

      i = this.plain(frame, i);
    }
  }

  private csi(frame: string, start: number): number {
    let j = start;
    let params = "";

    while (j < frame.length) {
      const c = frame[j] ?? "";

      if ((c >= "0" && c <= "9") || c === ";") {
        params += c;
        j += 1;
      } else {
        break;
      }
    }

    this.applyCsi(frame[j] ?? "", params);

    return j + 1;
  }

  private applyCsi(final: string, params: string): void {
    const parts = params.split(";");

    if (final === "H" || final === "f") {
      this.cursor = {
        row: clamp(toInt(parts[0], 1), this.rows),
        col: clamp(toInt(parts[1], 1), this.cols),
      };
    } else if (final === "K") {
      this.eraseLine(toInt(parts[0], 0));
    } else if (final === "m") {
      this.sgr =
        params === "" || params === "0" ? "" : this.sgr + `${ESC}[${params}m`;
    }
  }

  private eraseLine(mode: number): void {
    const line = this.grid[this.cursor.row - 1];

    if (line === undefined) {
      return;
    }

    const from = mode === 0 ? this.cursor.col - 1 : 0;
    const to = mode === 1 ? this.cursor.col : this.cols;

    for (let c = from; c < to && c < this.cols; c += 1) {
      line[c] = blank();
    }
  }

  /** Consume one printable grapheme (multi-byte safe) and place it, widening for
   *  CJK/emoji by marking the trailing cell as a continuation. */
  private plain(frame: string, i: number): number {
    const ch = frame[i] ?? "";

    if (ch === "\r") {
      this.cursor.col = 1;

      return i + 1;
    }

    if (ch < " ") {
      // LF and other control bytes don't occur in the absolute-positioned bar
      // frames; ignore them rather than model region scrolling here.
      return i + 1;
    }

    // Read a whole grapheme starting at i (so a surrogate pair / ZWJ stays intact).
    const rest = frame.slice(i);
    const [g] = graphemes(rest);
    const grapheme = g ?? ch;

    this.put(grapheme);

    return i + grapheme.length;
  }

  private put(grapheme: string): void {
    const line = this.grid[this.cursor.row - 1];
    const col = this.cursor.col - 1;

    if (line === undefined || col < 0 || col >= this.cols) {
      this.cursor.col += Math.max(1, displayWidth(grapheme));

      return;
    }

    line[col] = { ch: grapheme, sgr: this.sgr };

    if (displayWidth(grapheme) === 2 && col + 1 < this.cols) {
      line[col + 1] = { ch: "", sgr: this.sgr };
    }

    this.cursor.col += Math.max(1, displayWidth(grapheme));
  }
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(1, n), max);
}

/** Emit the minimal escape sequence that turns `prev` into `next`, cell by cell. */
function diffGrids(
  prev: ICell[][],
  next: ICell[][],
  rows: number,
  cols: number
): string {
  let out = "";

  for (let r = 0; r < rows; r += 1) {
    out += diffRow(prev[r] ?? [], next[r] ?? [], r + 1, cols);
  }

  return out;
}

/** Emit changed runs for one row: a CUP to each run's start, then its cells. */
function diffRow(
  prev: ICell[],
  next: ICell[],
  row: number,
  cols: number
): string {
  let out = "";
  let c = 0;

  while (c < cols) {
    if (cellsEqual(prev[c], next[c])) {
      c += 1;
      continue;
    }

    // Start of a damaged run — find its end.
    let end = c;

    while (end < cols && !cellsEqual(prev[end], next[end])) {
      end += 1;
    }

    out += `${ESC}[${row};${c + 1}H${runText(next, c, end)}`;
    c = end;
  }

  return out;
}

function cellsEqual(a: ICell | undefined, b: ICell | undefined): boolean {
  const x = a ?? blank();
  const y = b ?? blank();

  return x.ch === y.ch && x.sgr === y.sgr;
}

/** Render cells [from, to) of a row as text, switching SGR only when it changes
 *  and resetting at the end so colour never bleeds past the run. */
function runText(cells: ICell[], from: number, to: number): string {
  let out = "";
  let activeSgr = "";

  for (let c = from; c < to; c += 1) {
    const cell = cells[c] ?? blank();

    // The right half of a wide cell was already written by its left half.
    if (cell.ch === "") {
      continue;
    }

    if (cell.sgr !== activeSgr) {
      out += cell.sgr === "" ? RESET_SGR : cell.sgr;
      activeSgr = cell.sgr;
    }

    out += cell.ch;
  }

  if (activeSgr !== "") {
    out += RESET_SGR;
  }

  return out;
}

/**
 * A committed cell grid plus the cursor. `flush(frame)` applies the frame to a
 * working copy, returns the minimal delta from the committed grid to it (ending
 * with a cursor park), and commits — so successive identical frames emit nothing
 * but the cursor move.
 */
export class ScreenBuffer {
  private committed: ICell[][];
  private cursor: ICursor = { row: 1, col: 1 };

  constructor(
    private rows: number,
    private cols: number
  ) {
    this.committed = blankGrid(rows, cols);
  }

  /** Resize the grid (terminal resize); drops the committed state so the next
   *  flush repaints in full against a blank screen of the new size. */
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.committed = blankGrid(rows, cols);
    this.cursor = { row: 1, col: 1 };
  }

  /** Apply `frame`, commit it, and return the minimal delta that realises it —
   *  WITHOUT a trailing cursor move. The caller parks the cursor (`parkSequence`)
   *  or wraps the delta in save/restore, depending on whether it owns the cursor. */
  flush(frame: string): string {
    const working = cloneGrid(this.committed);
    const applier = new FrameApplier(working, this.rows, this.cols);

    applier.apply(frame);

    const delta = diffGrids(this.committed, working, this.rows, this.cols);

    this.committed = working;
    this.cursor = applier.cursor;

    return delta;
  }

  /** A CUP sequence to the cursor position the last flushed frame parked at. */
  parkSequence(): string {
    return `${ESC}[${this.cursor.row};${this.cursor.col}H`;
  }
}
