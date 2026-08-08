import { STYLE, paint } from "../style";
import { displayWidth, sliceToWidth } from "../width";
import { stripSgr } from "./ansi-plain";

/** Left-rail prefixes that must repeat on every soft-wrapped continuation row. */
const HANG_PREFIX = /^(│ {2}|│ |▌ {2}|▌ |\| {2}|\| )/;

/**
 * Wrap a (possibly ANSI) line to `cols` columns.
 * Prefers word boundaries; when the line starts with a card rail (`│  ` / `▌  `),
 * every continuation row re-emits that prefix so scrollback reflow cannot break
 * the left gutter. Closed agent rows (`│ … │`) keep both rails on each wrap.
 */
/** Chrome / cyan / plan — whichever the source line used on its rails. */
function boxedRailCode(line: string): string {
  if (line.includes(STYLE.cyan)) {
    return STYLE.cyan;
  }

  if (line.includes(STYLE.plan)) {
    return STYLE.plan;
  }

  return STYLE.chrome;
}

/** Empty closed row as one SGR span (avoids a dark/bright right-rail fleck). */
function atomicBoxedPad(cols: number, railCode: string): string {
  return paint(`│${" ".repeat(Math.max(0, cols - 2))}│`, railCode, true);
}

export function wrapAnsiLine(line: string, cols: number): string[] {
  if (cols <= 0) {
    return [""];
  }

  const plain = stripSgr(line);

  if (plain.length === 0) {
    return [""];
  }

  const boxed = parseBoxedRow(plain);
  const railCode = boxedRailCode(line);

  // Fits: still re-seal empty boxed rows. A mid-line RESET between `│…│`
  // left the right rail on the default/dark FG in iTerm on blank card rows.
  if (displayWidth(plain) <= cols) {
    if (boxed !== null && boxed.body.trim().length === 0) {
      return [atomicBoxedPad(cols, railCode)];
    }

    if (boxed !== null) {
      return [resealBoxedRails(line, boxed, cols, railCode)];
    }

    return [line];
  }

  if (boxed !== null) {
    const inner = Math.max(1, cols - boxed.leftCols - boxed.rightCols);
    const bodyRows = wrapPlainWords(boxed.body, inner);
    const leftPad = boxed.left.slice(1); // spaces after the glyph
    const left = paint("│", railCode, true) + leftPad;
    const right = paint("│", railCode, true);

    return bodyRows.map((row) => {
      if (row.length === 0) {
        return atomicBoxedPad(cols, railCode);
      }

      const pad = Math.max(0, inner - displayWidth(row));

      return `${left}${row}${" ".repeat(pad)}${right}`;
    });
  }

  const hang = HANG_PREFIX.exec(plain);
  const prefix = hang?.[1] ?? "";
  const prefixCols = displayWidth(prefix);
  const body = prefix.length > 0 ? plain.slice(prefix.length) : plain;
  const inner = Math.max(1, cols - prefixCols);
  const bodyRows = wrapPlainWords(body, inner);

  return bodyRows.map((row) => `${prefix}${row}`);
}

/**
 * Keep content SGR, but force both rails to `railCode` and pad to `cols`
 * so the right │ cannot inherit a stale/default foreground.
 */
function resealBoxedRails(
  line: string,
  boxed: {
    left: string;
    leftCols: number;
    rightCols: number;
    body: string;
  },
  cols: number,
  railCode: string
): string {
  const inner = Math.max(1, cols - boxed.leftCols - boxed.rightCols);
  const bodyAnsi = extractBoxedBodyAnsi(line, boxed.left.length);
  const pad = Math.max(0, inner - displayWidth(boxed.body));
  const leftPad = boxed.left.slice(1);
  const left = paint("│", railCode, true) + leftPad;
  const right = paint("│", railCode, true);

  return `${left}${bodyAnsi}${" ".repeat(pad)}${right}`;
}

/** Visible body between the leading `│…` rail and the trailing `│`. */
function extractBoxedBodyAnsi(line: string, leftPlainLen: number): string {
  let plainCount = 0;
  let i = 0;
  let start = 0;

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);

      if (end === -1) {
        break;
      }

      i = end + 1;
      continue;
    }

    plainCount += 1;
    i += 1;

    if (plainCount === leftPlainLen) {
      start = i;
      break;
    }
  }

  const lastPipe = line.lastIndexOf("│");

  if (lastPipe <= start) {
    return "";
  }

  // Drop the trailing rail and any SGR that paints it (…chrome│reset).
  let end = lastPipe;

  while (end > start && line[end - 1] === "m") {
    const esc = line.lastIndexOf("\x1b", end - 1);

    if (esc < start || line[esc + 1] !== "[") {
      break;
    }

    end = esc;
  }

  return line.slice(start, end).trimEnd();
}

/** Detect a closed card row: `│ … │`. */
function parseBoxedRow(plain: string): {
  left: string;
  right: string;
  leftCols: number;
  rightCols: number;
  body: string;
} | null {
  if (!plain.startsWith("│") || !plain.endsWith("│") || plain.length < 2) {
    return null;
  }

  // `│  content… │` / `│ content… │` / `│content…│` — keep the left pad intact.
  const left = plain.startsWith("│  ")
    ? "│  "
    : plain.startsWith("│ ")
      ? "│ "
      : "│";
  const right = "│";
  const body = plain.slice(left.length, plain.length - right.length).trimEnd();

  return {
    left,
    right,
    leftCols: displayWidth(left),
    rightCols: displayWidth(right),
    body,
  };
}

/** Hard-break one token wider than `width` into `out`; return the leftover. */
function breakWideToken(word: string, width: number, out: string[]): string {
  let rest = word;

  while (displayWidth(rest) > width) {
    const head = sliceToWidth(rest, width);

    if (head.text.length === 0) {
      out.push(rest.slice(0, 1));
      rest = rest.slice(1);
      continue;
    }

    out.push(head.text);
    rest = rest.slice(head.text.length);
  }

  return rest;
}

/** Word-wrap plain text; hard-break a single token wider than `width`. */
function wrapPlainWords(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    let cur = "";

    for (const word of rawLine.split(" ")) {
      const candidate = cur.length === 0 ? word : `${cur} ${word}`;

      if (displayWidth(candidate) <= width) {
        cur = candidate;
        continue;
      }

      if (cur.length > 0) {
        out.push(cur);
      }

      cur = breakWideToken(word, width, out);
    }

    out.push(cur);
  }

  return out.length > 0 ? out : [""];
}

/** Wrap every logical line; empty input → one empty row. */
export function wrapAnsiLines(
  lines: readonly string[],
  cols: number
): string[] {
  if (lines.length === 0) {
    return [""];
  }

  const out: string[] = [];

  for (const line of lines) {
    out.push(...wrapAnsiLine(line, cols));
  }

  return out;
}
