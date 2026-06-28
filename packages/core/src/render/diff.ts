import { STYLE, paint } from "./style";
import { displayWidth, padToWidth, sliceToWidth } from "./width";

/**
 * Line-level diff rendering. The old renderer dumped *every* old line as `-` then
 * *every* new line as `+`, so a one-word change in a 40-line block printed 80
 * noisy lines. This computes a longest-common-subsequence line diff, so unchanged
 * lines show once as dim context and only the genuinely changed lines carry `-`/`+`
 * — with optional intra-line word highlighting and a side-by-side mode.
 */

export interface IDiffOptions {
  /** Emit ANSI color (terminal) vs plain `-`/`+` text (logs). Default true. */
  color?: boolean;
  /** Unchanged lines kept around each change; longer runs collapse to `⋯`. Default 3. */
  context?: number;
  /** Render old/new as two aligned columns instead of a unified `-`/`+` list. */
  sideBySide?: boolean;
  /** Total columns for side-by-side layout. Default 80. */
  columns?: number;
  /** Highlight the changed words within a one-line replacement. Default true. */
  wordLevel?: boolean;
}

type OpType = "eq" | "del" | "add";

interface IOp {
  readonly type: OpType;
  readonly text: string;
}

const SEP = " │ ";

/** Above this many DP cells (n·m) the LCS matrix would cost too much memory/CPU,
 *  so we fall back to a plain replacement rather than freeze the terminal. */
const MAX_DIFF_CELLS = 250_000;

/** A longest-common-subsequence line diff: unchanged lines become `eq`, removed
 *  `del`, added `add`, in original order. O(n·m) DP — fine for edit-sized snippets.
 *  Past `MAX_DIFF_CELLS` it degrades to "all old removed, all new added" (the
 *  pre-LCS behaviour) so a huge input can't allocate a giant matrix or hang. */
function diffLines(a: readonly string[], b: readonly string[]): IOp[] {
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): IOp => ({ type: "del", text })),
      ...b.map((text): IOp => ({ type: "add", text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i] ?? [];
      const next = dp[i + 1] ?? [];

      row[j] =
        a[i] === b[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: IOp[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ type: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j] ?? "" });
      j += 1;
    }
  }

  while (i < n) {
    ops.push({ type: "del", text: a[i] ?? "" });
    i += 1;
  }

  while (j < m) {
    ops.push({ type: "add", text: b[j] ?? "" });
    j += 1;
  }

  return ops;
}

/** Collapse runs of `eq` lines longer than `2·context` to the leading/trailing
 *  `context` lines plus a `⋯` gap marker, so large unchanged regions don't drown
 *  the actual change. Boundary runs (start/end of file) keep only the inner side. */
function collapseContext(ops: readonly IOp[], context: number): IOp[] {
  const out: IOp[] = [];
  let run: IOp[] = [];

  const flush = (atStart: boolean, atEnd: boolean): void => {
    if (run.length <= context * 2) {
      out.push(...run);
    } else {
      if (!atStart) {
        out.push(...run.slice(0, context));
      }

      out.push({ type: "eq", text: "⋯" });

      if (!atEnd) {
        out.push(...run.slice(run.length - context));
      }
    }

    run = [];
  };

  for (const op of ops) {
    if (op.type === "eq") {
      run.push(op);
    } else {
      flush(out.length === 0, false);
      out.push(op);
    }
  }

  flush(out.length === 0, true);

  return out;
}

/** Tokenize into words and the whitespace between them, both kept so a rejoin is
 *  loss-less — the unit a word-level diff compares. */
function tokenize(line: string): string[] {
  return line.split(/(\s+)/u).filter((t) => t.length > 0);
}

/** Paint the tokens of `from`→`to` that differ, leaving shared tokens plain, so a
 *  one-line edit shows *which* words changed. Returns the two rendered lines. */
function highlightPair(
  from: string,
  to: string,
  color: boolean
): { del: string; add: string } {
  const ops = diffLines(tokenize(from), tokenize(to));
  let del = "";
  let add = "";

  for (const op of ops) {
    if (op.type === "eq") {
      del += op.text;
      add += op.text;
    } else if (op.type === "del") {
      del += paint(op.text, STYLE.red + STYLE.bold, color);
    } else {
      add += paint(op.text, STYLE.green + STYLE.bold, color);
    }
  }

  return { del, add };
}

/** True when ops[idx] starts an isolated one-line replacement (single del then
 *  single add), the case worth a word-level highlight. */
function isOneLineSwap(ops: readonly IOp[], idx: number): boolean {
  return (
    ops[idx]?.type === "del" &&
    ops[idx + 1]?.type === "add" &&
    ops[idx - 1]?.type !== "del" &&
    ops[idx + 2]?.type !== "add"
  );
}

/** Render the unified `-`/`+` view with dim context and optional word highlights. */
function renderUnified(
  ops: readonly IOp[],
  wordLevel: boolean,
  color: boolean
): string {
  const lines: string[] = [];

  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k];

    if (op === undefined) {
      continue;
    }

    if (op.type === "eq") {
      lines.push(paint(`  ${op.text}`, STYLE.dim, color));
      continue;
    }

    if (wordLevel && isOneLineSwap(ops, k)) {
      const { del, add } = highlightPair(
        op.text,
        ops[k + 1]?.text ?? "",
        color
      );

      lines.push(`${paint("-", STYLE.red, color)} ${del}`);
      lines.push(`${paint("+", STYLE.green, color)} ${add}`);
      k += 1; // consume the paired add
      continue;
    }

    lines.push(
      op.type === "del"
        ? paint(`- ${op.text}`, STYLE.red, color)
        : paint(`+ ${op.text}`, STYLE.green, color)
    );
  }

  return lines.join("\n");
}

/** Group ops into aligned rows for the two-column view: an `eq` fills both sides,
 *  while a block of dels/adds between two `eq`s is zipped row-by-row. */
function pairRows(ops: readonly IOp[]): { left?: string; right?: string }[] {
  const rows: { left?: string; right?: string }[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  const flushBlock = (): void => {
    const n = Math.max(dels.length, adds.length);

    for (let i = 0; i < n; i += 1) {
      rows.push({ left: dels[i], right: adds[i] });
    }

    dels = [];
    adds = [];
  };

  for (const op of ops) {
    if (op.type === "del") {
      dels.push(op.text);
    } else if (op.type === "add") {
      adds.push(op.text);
    } else {
      flushBlock();
      rows.push({ left: op.text, right: op.text });
    }
  }

  flushBlock();

  return rows;
}

/** Fit one cell to `colW` columns and paint it by side (red left / green right). */
function cell(
  text: string | undefined,
  colW: number,
  code: string,
  color: boolean
): string {
  const fitted = padToWidth(sliceToWidth(text ?? "", colW).text, colW);

  return text === undefined ? fitted : paint(fitted, code, color);
}

/** Render the side-by-side view: old on the left, new on the right, `│`-separated. */
function renderSideBySide(
  ops: readonly IOp[],
  columns: number,
  color: boolean
): string {
  const colW = Math.max(1, Math.floor((columns - displayWidth(SEP)) / 2));

  return pairRows(ops)
    .map(({ left, right }) => {
      const same = left === right;
      const leftCode = same ? STYLE.dim : STYLE.red;
      const rightCode = same ? STYLE.dim : STYLE.green;

      return (
        cell(left, colW, leftCode, color) +
        SEP +
        cell(right, colW, rightCode, color)
      );
    })
    .join("\n");
}

/**
 * Render a diff between `oldText` and `newText` for the terminal. Defaults to a
 * unified `-`/`+` view with dim context and word-level highlighting; pass
 * `sideBySide` for two columns. `color: false` yields plain `-`/`+` text for logs.
 */
export function renderDiff(
  oldText: string,
  newText: string,
  opts: IDiffOptions = {}
): string {
  const {
    color = true,
    context = 3,
    sideBySide = false,
    columns = 80,
    wordLevel = true,
  } = opts;

  const ops = collapseContext(
    diffLines(oldText.split("\n"), newText.split("\n")),
    context
  );

  return sideBySide
    ? renderSideBySide(ops, columns, color)
    : renderUnified(ops, wordLevel, color);
}
