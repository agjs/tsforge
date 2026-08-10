import { STYLE, paint } from "./style";
import { displayWidth, padToWidth } from "./width";

/**
 * Terminal drawing primitives — title-tabbed boxes and box-drawn tables, the look
 * a modern coding CLI uses to make tool output legible. Pure string→string (no
 * cursor control, no streaming, no readline interaction), so they render discrete
 * events ONLY and can never disturb input. `color: false` (logs / non-TTY)
 * degrades to plain indented text.
 */

/** One source of truth for status → glyph, so every event renders consistently. */
export const GLYPH = {
  done: "✓",
  fail: "✗",
  warn: "⚠",
  info: "●",
  run: "→",
  create: "✚",
  edit: "✎",
  read: "◎",
  search: "⌕",
  bullet: "•",
  reopen: "○",
} as const;

/** Glyph for a tool name (live stream markers + settled tool lines). */
export function toolGlyph(name: string): string {
  switch (name) {
    case "read":
      return GLYPH.read;
    case "search":
    case "symbol_search":
    case "find_references":
      return GLYPH.search;
    case "run":
    case "script":
      return GLYPH.run;
    case "create":
    case "scaffold_ui":
    case "task_add":
      return GLYPH.create;
    case "edit":
    case "edit_lines":
    case "task_update":
      return GLYPH.edit;
    case "task_complete":
      return GLYPH.done;
    case "task_focus":
    case "task_list":
      return GLYPH.read;
    case "task_uncomplete":
      return GLYPH.reopen;
    default:
      return GLYPH.info;
  }
}

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

/** Terminal width, clamped to a sane band — a stable default off a TTY. */
function termWidth(): number {
  const cols = process.stdout.columns;

  return Number.isFinite(cols)
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols))
    : DEFAULT_WIDTH;
}

export interface IBoxOptions {
  glyph?: string;
  accent?: string;
  color?: boolean;
  width?: number;
}

/**
 * A title-tabbed block: a top rule that opens with `┌─ <glyph> <title> ` and runs
 * to the terminal width, each body line on a `│ ` gutter, closed by a `└` rule.
 * Body lines may already contain ANSI — the right edge is never padded, so no
 * fragile visible-width math is needed.
 */
export function box(
  title: string,
  bodyLines: readonly string[],
  opts: IBoxOptions = {}
): string {
  const {
    glyph = "",
    accent = STYLE.brand,
    color = true,
    width = termWidth(),
  } = opts;
  const head = glyph.length > 0 ? `${glyph} ${title}` : title;

  if (!color) {
    const body = bodyLines.map((l) => `      ${l}`).join("\n");

    return bodyLines.length > 0 ? `  ${head}\n${body}` : `  ${head}`;
  }

  const opener = "┌─ ";
  const rule = "─".repeat(
    Math.max(0, width - opener.length - displayWidth(head) - 1)
  );
  const top = `${paint(opener, STYLE.dim, color)}${paint(head, `${accent}${STYLE.bold}`, color)} ${paint(rule, STYLE.dim, color)}`;
  const bar = paint("│", STYLE.dim, color);
  const bottom = paint(
    `└${"─".repeat(Math.max(0, width - 1))}`,
    STYLE.dim,
    color
  );

  if (bodyLines.length === 0) {
    return `${top}\n${bottom}`;
  }

  const body = bodyLines.map((l) => `${bar} ${l}`).join("\n");

  return `${top}\n${body}\n${bottom}`;
}

/**
 * Render rows as a real box-drawn table — `rows[0]` is the header. Columns auto-
 * size to their widest cell; the header is accented. The model answers with GFM
 * markdown tables constantly, which print as raw `|` soup otherwise.
 */
export function table(
  rows: readonly (readonly string[])[],
  color = true
): string {
  if (rows.length === 0) {
    return "";
  }

  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...rows.map((r) => displayWidth(r[c] ?? "")))
  );
  const bar = paint("│", STYLE.dim, color);

  const rule = (left: string, mid: string, right: string): string =>
    paint(
      `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`,
      STYLE.dim,
      color
    );

  const renderRow = (cells: readonly string[], header: boolean): string => {
    const inner = widths
      .map((w, c) => {
        const cell = padToWidth(cells[c] ?? "", w);

        return ` ${header ? paint(cell, `${STYLE.brand}${STYLE.bold}`, color) : cell} `;
      })
      .join(bar);

    return `${bar}${inner}${bar}`;
  };

  const [header, ...body] = rows;

  return [
    rule("┌", "┬", "┐"),
    renderRow(header ?? [], true),
    rule("├", "┼", "┤"),
    ...body.map((r) => renderRow(r, false)),
    rule("└", "┴", "┘"),
  ].join("\n");
}
