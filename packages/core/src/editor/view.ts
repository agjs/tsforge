import { graphemes } from "./segments";

export interface IEditorInput {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface IEditorOptions {
  columns: number;
  maxRows: number;
  color: boolean;
}

export interface IEditorFrame {
  frame: string;
  rows: number;
  cursorRow: number;
  cursorCol: number;
}

interface IWrappedRow {
  text: string;
  cursorRow?: number;
  cursorCol?: number;
}

interface IVisibleWindow {
  startLine: number;
  endLine: number;
  clippedAbove: boolean;
  clippedBelow: boolean;
}

/**
 * Wrap a single logical line into visual rows, accounting for grapheme width.
 * Returns array of { text, cursorRow, cursorCol } for rows containing the cursor,
 * or undefined cursor position if the cursor isn't in this line.
 */
function wrapLine(
  line: string,
  cursorCol: number,
  columns: number
): IWrappedRow[] {
  if (columns <= 0) {
    return [];
  }

  const graphemeList = graphemes(line);
  const rows: IWrappedRow[] = [];
  let row = "";
  let rowCursorCol: number | undefined;
  let visualRow = 0;

  for (let i = 0; i < graphemeList.length; i += 1) {
    const g = graphemeList[i];

    if (row.length >= columns) {
      rows.push({
        text: row,
        cursorRow: rowCursorCol !== undefined ? visualRow : undefined,
        cursorCol: rowCursorCol,
      });
      row = "";
      rowCursorCol = undefined;
      visualRow += 1;
    }

    if (i === cursorCol) {
      rowCursorCol = row.length;
    }

    if (g !== undefined) {
      row += g;
    }
  }

  // Handle cursor at end of line
  if (graphemeList.length === cursorCol) {
    rowCursorCol = row.length;
  }

  // Push final row
  rows.push({
    text: row,
    cursorRow: rowCursorCol !== undefined ? visualRow : undefined,
    cursorCol: rowCursorCol,
  });

  return rows;
}

/**
 * Compute the number of visual rows needed to render each logical line.
 */
function computeLineVisualRows(lines: string[], columns: number): number[] {
  return lines.map((line) => {
    const wrapped = wrapLine(line, graphemes(line).length, columns);

    return wrapped.length;
  });
}

/**
 * Try to fit lines into maxRows, ensuring cursor line is visible.
 * Returns { startLine, endLine } of the visible window.
 * The window tries to leave room for scroll indicators.
 */
function fitLinesInWindow(
  lineVisualRows: number[],
  cursorLine: number,
  maxRows: number
): { startLine: number; endLine: number } {
  // Reserve rows for indicators if needed
  const indicatorReserve = 1; // one row for above/below indicator

  let startLine = 0;
  let endLine = 0;
  let totalRows = 0;
  const availRows = maxRows - indicatorReserve;

  // Greedy: fit as many lines as possible starting from cursor line
  for (let i = cursorLine; i < lineVisualRows.length; i += 1) {
    const rows = lineVisualRows[i];

    if (rows !== undefined && totalRows + rows <= availRows) {
      totalRows += rows;
      endLine = i + 1;
    } else {
      break;
    }
  }

  // If cursor line not yet visible, back up
  if (endLine <= cursorLine) {
    endLine = cursorLine + 1;
    totalRows = 0;

    for (let i = cursorLine; i < endLine; i += 1) {
      const rows = lineVisualRows[i];

      if (rows !== undefined) {
        totalRows += rows;
      }
    }
  }

  // Fill remaining space backwards from cursor
  for (let i = cursorLine - 1; i >= 0 && totalRows < availRows; i -= 1) {
    const rows = lineVisualRows[i];

    if (rows !== undefined && totalRows + rows <= availRows) {
      totalRows += rows;
      startLine = i;
    } else {
      break;
    }
  }

  return { startLine, endLine };
}

/**
 * Compute which logical line range to display given the cursor position
 * and maxRows constraint.
 */
function computeVisibleWindow(
  lines: string[],
  cursorLine: number,
  maxRows: number,
  columns: number
): IVisibleWindow {
  if (maxRows <= 0 || lines.length === 0) {
    return {
      startLine: 0,
      endLine: 0,
      clippedAbove: false,
      clippedBelow: false,
    };
  }

  const lineVisualRows = computeLineVisualRows(lines, columns);
  const { startLine, endLine } = fitLinesInWindow(
    lineVisualRows,
    cursorLine,
    maxRows
  );

  return {
    startLine,
    endLine,
    clippedAbove: startLine > 0,
    clippedBelow: endLine < lines.length,
  };
}

/**
 * Render a single logical line and track cursor position if present.
 */
function renderLineToFrame(
  line: string,
  isCurrentLine: boolean,
  cursorCol: number,
  columns: number,
  clippedAbove: boolean,
  currentTotalRows: number
): {
  frameStr: string;
  visualRowCount: number;
  cursorRow?: number;
  cursorCol?: number;
} {
  const wrapped = wrapLine(line, isCurrentLine ? cursorCol : -1, columns);
  let frameStr = "";
  let foundCursor: { row: number; col: number } | undefined;

  for (let rowIdx = 0; rowIdx < wrapped.length; rowIdx += 1) {
    const wrappedRow = wrapped[rowIdx];

    if (wrappedRow === undefined) {
      continue;
    }

    frameStr += wrappedRow.text;

    if (isCurrentLine && wrappedRow.cursorRow !== undefined) {
      const offset = clippedAbove ? 1 : 0;

      foundCursor = {
        row: currentTotalRows + wrappedRow.cursorRow + offset,
        col: wrappedRow.cursorCol ?? 0,
      };
    }

    // Add newline between visual rows (but not after last row)
    if (rowIdx < wrapped.length - 1) {
      frameStr += "\n";
    }
  }

  return {
    frameStr,
    visualRowCount: wrapped.length,
    cursorRow: foundCursor?.row,
    cursorCol: foundCursor?.col,
  };
}

/**
 * Split the main renderEditor function logic into smaller parts to reduce complexity.
 * This helper builds the output frame string from visible window lines.
 */
function buildFrameString(
  lines: string[],
  window: IVisibleWindow,
  cursorLine: number,
  cursorCol: number,
  columns: number
): {
  frame: string;
  cursorRow: number;
  cursorCol: number;
  totalRows: number;
} {
  let frame = "";
  let totalVisualRows = 0;
  let cursorRowResult = 0;
  let cursorColResult = 0;

  // Add "↑ N more" indicator if clipped above
  if (window.clippedAbove) {
    const moreCount = window.startLine;
    const indicator = `↑ ${moreCount} more`;

    frame += indicator + "\n";
    totalVisualRows += 1;
  }

  // Render visible lines
  for (let lineIdx = window.startLine; lineIdx < window.endLine; lineIdx += 1) {
    const line = lines[lineIdx];

    if (line === undefined) {
      continue;
    }

    const isCurrentLine = lineIdx === cursorLine;
    const {
      frameStr,
      visualRowCount,
      cursorRow,
      cursorCol: cursorColRendered,
    } = renderLineToFrame(
      line,
      isCurrentLine,
      cursorCol,
      columns,
      window.clippedAbove,
      totalVisualRows
    );

    frame += frameStr;
    totalVisualRows += visualRowCount;

    if (cursorRow !== undefined && cursorColRendered !== undefined) {
      cursorRowResult = cursorRow;
      cursorColResult = cursorColRendered;
    }

    // Add newline between logical lines (but not after last line)
    if (lineIdx < window.endLine - 1) {
      frame += "\n";
      totalVisualRows += 1;
    }
  }

  // Add "↓ N more" indicator if clipped below
  if (window.clippedBelow) {
    frame += "\n";
    totalVisualRows += 1;

    const moreCount = lines.length - window.endLine;
    const indicator = `↓ ${moreCount} more`;

    frame += indicator;
  }

  return {
    frame,
    cursorRow: cursorRowResult,
    cursorCol: cursorColResult,
    totalRows: totalVisualRows,
  };
}

/**
 * Render the editor buffer as an ANSI-escaped frame positioned at a given
 * terminal row. Returns the frame (escape sequences + text), total rows used,
 * and the on-screen cursor position.
 */
export function renderEditor(
  input: IEditorInput,
  opts: IEditorOptions
): IEditorFrame {
  const { lines, cursorLine, cursorCol } = input;
  const { columns, maxRows } = opts;

  // Handle empty buffer
  if (lines.length === 0 || columns <= 0 || maxRows <= 0) {
    return { frame: "", rows: 0, cursorRow: 0, cursorCol: 0 };
  }

  // Compute visible window
  const window = computeVisibleWindow(lines, cursorLine, maxRows, columns);

  // Build the frame string and get cursor position
  const {
    frame,
    cursorRow,
    cursorCol: cursorColResult,
    totalRows,
  } = buildFrameString(lines, window, cursorLine, cursorCol, columns);

  return {
    frame,
    rows: Math.min(totalRows, maxRows),
    cursorRow,
    cursorCol: cursorColResult,
  };
}
