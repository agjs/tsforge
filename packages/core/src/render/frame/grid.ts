import type { ICell, IFrame } from "./frame.types";
import { cup, EL_EOL } from "./codes";

const SPACE: ICell = { ch: " " };

/** Allocate a blank frame filled with spaces. */
export function blankFrame(rows: number, cols: number): IFrame {
  const cells: ICell[][] = [];

  for (let r = 0; r < rows; r += 1) {
    const row: ICell[] = [];

    for (let c = 0; c < cols; c += 1) {
      row.push(SPACE);
    }

    cells.push(row);
  }

  return { rows, cols, cells };
}

/** Clone a frame into a mutable grid for painting. */
export function cloneFrame(frame: IFrame): ICell[][] {
  return frame.cells.map((row) => row.map((cell) => ({ ch: cell.ch })));
}

/**
 * Write plain lines into a rectangular region of a mutable grid. Lines are
 * clipped to the rect; shorter lines are space-padded by leaving prior cells.
 */
export function writeRect(
  grid: ICell[][],
  rect: { row: number; col: number; rows: number; cols: number },
  lines: readonly string[]
): void {
  for (let r = 0; r < rect.rows; r += 1) {
    const targetRow = rect.row + r;
    const row = grid[targetRow];

    if (row === undefined) {
      continue;
    }

    const text = lines[r] ?? "";

    for (let c = 0; c < rect.cols; c += 1) {
      const targetCol = rect.col + c;

      if (targetCol >= row.length) {
        break;
      }

      row[targetCol] = { ch: text[c] ?? " " };
    }
  }
}

/** Freeze a mutable grid into an IFrame. */
export function freezeFrame(
  grid: readonly (readonly ICell[])[],
  rows: number,
  cols: number
): IFrame {
  return {
    rows,
    cols,
    cells: grid.map((row) => row.map((cell) => ({ ch: cell.ch }))),
  };
}

function sameSize(prev: IFrame | null, next: IFrame): prev is IFrame {
  return prev !== null && prev.rows === next.rows && prev.cols === next.cols;
}

/**
 * Diff `next` against `prev` into minimal CUP + line writes. When sizes differ,
 * redraw the whole screen from the home position.
 */
export function diffFrames(prev: IFrame | null, next: IFrame): string {
  if (!sameSize(prev, next)) {
    let out = cup(1, 1);

    for (let r = 0; r < next.rows; r += 1) {
      const row = next.cells[r] ?? [];

      out += cup(r + 1, 1);
      out += row.map((c) => c.ch).join("") + EL_EOL;
    }

    return out;
  }

  let out = "";

  for (let r = 0; r < next.rows; r += 1) {
    const prevRow = prev.cells[r] ?? [];
    const nextRow = next.cells[r] ?? [];
    let dirty = false;

    for (let c = 0; c < next.cols; c += 1) {
      if ((prevRow[c]?.ch ?? " ") !== (nextRow[c]?.ch ?? " ")) {
        dirty = true;
        break;
      }
    }

    if (dirty) {
      out += cup(r + 1, 1);
      out += nextRow.map((c) => c.ch).join("") + EL_EOL;
    }
  }

  return out;
}
