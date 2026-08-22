import type { IStatusInfo } from "../render.types";
import { RESET, STYLE, paint, truecolor, truecolorBg } from "../style";
import { displayWidth, sliceToWidth } from "../width";
import { stripSgr } from "./ansi-plain";
import type { ActiveSurface } from "./focus";

/** Console palette — Lovable agent-console greens / meta / warns. */
export const CONSOLE = {
  green: STYLE.green,
  bright: truecolor(74, 222, 128),
  /** Primary body text (#e4e4e7) — menus, rail titles, unreadables-not-dim. */
  fg: truecolor(228, 228, 231),
  /** Secondary body (#a1a1aa) — done items, hints; still readable on #141414. */
  soft: truecolor(161, 161, 170),
  muted: STYLE.dim,
  /** Match STYLE.chrome — greenish rule made pane gutters disagree with AGENT/input. */
  rule: STYLE.chrome,
  warn: STYLE.yellow,
  fail: STYLE.red,
  /** Status-strip secondary (model name) — soft zinc, never sky-blue/cyan. */
  meta: truecolor(161, 161, 170),
  accent: truecolor(251, 191, 36),
  /** Opaque canvas (#141414) — one surface for the whole frame. */
  bg: truecolorBg(20, 20, 20),
} as const;

/**
 * Horizontal breathing room — enough inset to breathe, not a floating island.
 * Hairlines stay full-bleed; text does not.
 */
export const CHROME_PAD_X = 3;
/**
 * Vertical air inside the outer frame (above the title / under the hairline).
 * Keep this small — matching {@link CHROME_PAD_X} in *rows* floated the chrome.
 */
export const CHROME_PAD_Y = 1;

/**
 * Fit a content line into `cols` with left/right inset.
 * Prefer this over painting flush against the frame edge.
 * Always returns exactly `cols` display columns (hard clamp) so pane gutters
 * cannot be overwritten by wide/emoji/ANSI content.
 */
export function insetX(
  line: string,
  cols: number,
  pad: number = CHROME_PAD_X
): string {
  if (cols <= 0) {
    return "";
  }

  const p = Math.max(0, Math.min(pad, Math.floor(Math.max(0, cols - 1) / 2)));

  if (p === 0) {
    return exactCols(line, cols);
  }

  const inner = cols - 2 * p;
  const fitted = exactCols(line, inner);

  return exactCols(`${" ".repeat(p)}${fitted}${" ".repeat(p)}`, cols);
}

/** Inner width available after left/right inset. */
export function insetInnerCols(
  cols: number,
  pad: number = CHROME_PAD_X
): number {
  const p = Math.max(0, Math.min(pad, Math.floor(Math.max(0, cols - 1) / 2)));

  return Math.max(0, cols - 2 * p);
}

export interface ITopStatusOpts {
  readonly info: IStatusInfo;
  readonly worklistBadge?: string;
  readonly cols: number;
  readonly color?: boolean;
}

/** Legacy one-liner — prefer {@link formatConsoleTitle}. */
export function formatTopStatus(opts: ITopStatusOpts): string {
  return formatConsoleTitle({
    info: opts.info,
    cwd: "",
    worklistBadge: opts.worklistBadge,
    cols: opts.cols,
    color: opts.color,
  });
}

export interface IConsoleTitleOpts {
  readonly info: IStatusInfo | null;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly worklistBadge?: string;
  readonly cols: number;
  readonly color?: boolean;
}

/**
 * Single dense status strip — one place for session chrome (no input cutout):
 *   left  → brand · path · scope   (where)
 *   right → model · % · [PLAN]/[NORMAL] · ✓ · Nt   (live)
 *   Task counts live in the Tasks rail — not duplicated here.
 */
export function formatConsoleTitle(opts: IConsoleTitleOpts): string {
  const color = opts.color ?? true;
  const sep = paint(" · ", CONSOLE.muted, color);
  const leftBits: string[] = [paint("▚ TSFORGE", CONSOLE.bright, color)];
  const rightBits: string[] = [];

  if (opts.cwd.length > 0) {
    leftBits.push(paint(shortPath(opts.cwd), CONSOLE.green, color));
  }

  if (opts.info !== null && opts.info.scope.length > 0) {
    leftBits.push(paint(opts.info.scope, CONSOLE.muted, color));
  }

  if (opts.info !== null) {
    rightBits.push(paint(shortModel(opts.info.model), CONSOLE.meta, color));

    if (opts.info.contextWindow > 0) {
      rightBits.push(
        paint(`${String(ctxPct(opts.info))}%`, CONSOLE.muted, color)
      );
    }

    if (opts.info.mode !== undefined && opts.info.mode.length > 0) {
      rightBits.push(modeChip(opts.info.mode, color));
    }

    if (opts.info.activity !== undefined && opts.info.activity.length > 0) {
      rightBits.push(paint(opts.info.activity, CONSOLE.muted, color));
    } else {
      rightBits.push(statusChip(opts.info.status, color));
    }

    if (
      opts.info.tokensPerSecond !== undefined &&
      opts.info.tokensPerSecond > 0
    ) {
      rightBits.push(
        paint(`${String(opts.info.tokensPerSecond)}t`, CONSOLE.muted, color)
      );
    }
  }

  return insetX(
    splitBar(
      leftBits.join(sep),
      rightBits.join(sep),
      insetInnerCols(opts.cols)
    ),
    opts.cols
  );
}

/**
 * Pinned top chrome: air, title, air, hairline (┬ starts the panel gutter).
 */
export function formatConsoleTopbar(opts: {
  readonly info: IStatusInfo | null;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly worklistBadge?: string;
  readonly cols: number;
  readonly color?: boolean;
  readonly splitCol?: number;
  /** When false, omit title air (short terminals). Default true. */
  readonly padTop?: boolean;
}): string[] {
  const lines: string[] = [];
  const padded = opts.padTop !== false;

  if (padded) {
    for (let i = 0; i < CHROME_PAD_Y; i += 1) {
      lines.push("");
    }
  }

  lines.push(formatConsoleTitle(opts));

  if (padded) {
    for (let i = 0; i < CHROME_PAD_Y; i += 1) {
      lines.push("");
    }
  }

  lines.push(
    hairline(opts.cols, "─", {
      splitCol: opts.splitCol,
      junction: "┬",
      color: opts.color,
    })
  );

  return lines;
}

export interface IMainHeaderOpts {
  readonly info: IStatusInfo | null;
  readonly cwd: string;
  readonly cols: number;
  readonly color?: boolean;
  readonly streaming?: boolean;
}

/** Folded into {@link formatConsoleTitle}; kept for older call sites. */
export function formatMainHeader(opts: IMainHeaderOpts): string {
  return formatConsoleTitle({
    info: opts.info,
    cwd: opts.cwd,
    cols: opts.cols,
    color: opts.color,
  });
}

export interface IRailHeaderOpts {
  readonly done: number;
  readonly total: number;
  readonly cols: number;
  readonly color?: boolean;
  /** Left label — default `Tasks`. */
  readonly title?: string;
  /** When set, replaces the done/total chip on the right (Gate rail). */
  readonly badge?: string;
}

/** Sticky rail title rows: label row + under-rule (borders the title cell). */
export const RAIL_TITLE_ROWS = 2;

/**
 * Side-rail title: muted label left, bright `done/total` right.
 * Lives under the ┬ hairline; pair with {@link formatRailTitleRule} for the
 * bottom border so the cell reads like the screenshot title bar.
 */
export function formatRailHeader(opts: IRailHeaderOpts): string {
  const color = opts.color ?? true;
  const trimmed = (opts.title ?? "Tasks").trim();
  const label = trimmed.length > 0 ? trimmed : "Tasks";
  const left = paint(label, CONSOLE.muted, color);
  const countText =
    opts.badge ??
    `${String(Math.max(0, opts.done))}/${String(Math.max(0, opts.total))}`;
  const right =
    opts.badge !== undefined || opts.total > 0
      ? paint(countText, CONSOLE.bright, color)
      : paint(countText, CONSOLE.muted, color);

  return insetX(splitBar(left, right, insetInnerCols(opts.cols)), opts.cols);
}

/** Full-width under-rule for the rail title cell (panel column only). */
export function formatRailTitleRule(cols: number, color = true): string {
  return paint("─".repeat(Math.max(0, cols)), CONSOLE.rule, color);
}

/** Sticky title block: `[header, under-rule]`. */
export function formatRailTitleBlock(opts: IRailHeaderOpts): string[] {
  return [formatRailHeader(opts), formatRailTitleRule(opts.cols, opts.color)];
}

/** Full-width hairline, optionally with a junction glyph at `splitCol` (0-based). */
export function hairline(
  cols: number,
  fill = "─",
  opts?: { splitCol?: number; junction?: string; color?: boolean }
): string {
  const color = opts?.color ?? true;
  const n = Math.max(0, cols);

  if (n === 0) {
    return "";
  }

  const splitCol = opts?.splitCol;
  const junction = opts?.junction ?? "┼";

  if (splitCol === undefined || splitCol < 0 || splitCol >= n) {
    return paint(fill.repeat(n), CONSOLE.rule, color);
  }

  const left = fill.repeat(splitCol);
  const right = fill.repeat(Math.max(0, n - splitCol - 1));

  return paint(`${left}${junction}${right}`, CONSOLE.rule, color);
}

export type HintFocus = ActiveSurface;

/** Dim hint strings — unused in the minimal chrome (kept for focus tests). */
export function formatHints(focus: HintFocus, busy: boolean): string {
  if (busy) {
    return "Ctrl+C abort  ·  PgUp scroll  ·  Ctrl+G hide";
  }

  if (focus === "panel") {
    return "↑↓ select  ·  Esc prompt  ·  Ctrl+G hide";
  }

  if (focus === "scrollback") {
    return "↑↓ scroll  ·  Esc prompt  ·  Ctrl+O dump";
  }

  return "Shift+Tab mode  ·  @ files  ·  /help  ·  Ctrl+G hide";
}

function statusChip(status: string, color: boolean): string {
  if (status === "ready" || status === "done" || status === "responded") {
    return paint("✓", CONSOLE.bright, color);
  }

  if (status === "stuck") {
    return paint("✗", CONSOLE.fail, color);
  }

  return paint("●", CONSOLE.warn, color);
}

/**
 * Compact outlined mode chip — plan uses the amber accent; normal stays light
 * chrome. Same language as the role badges (accent fg, no fill).
 */
function modeChip(mode: string, color: boolean): string {
  const id = mode.trim().toLowerCase();
  const label = ` ${id.length > 0 ? id.toUpperCase() : "MODE"} `;

  if (!color) {
    return label.trim();
  }

  if (id === "plan") {
    return `${STYLE.plan}${STYLE.bold}${label}${RESET}`;
  }

  return `${STYLE.chromeLight}${label}${RESET}`;
}

function ctxPct(info: IStatusInfo): number {
  return Math.round((info.contextTokens / info.contextWindow) * 100);
}

function shortModel(model: string): string {
  if (model.length <= 22) {
    return model;
  }

  return `${model.slice(0, 20)}…`;
}

function shortPath(cwd: string): string {
  const home = process.env.HOME;
  const raw =
    home !== undefined && home.length > 0 && cwd.startsWith(home)
      ? `~${cwd.slice(home.length)}`
      : cwd;

  if (raw.length <= 28) {
    return raw;
  }

  const parts = raw.split("/").filter((p) => p.length > 0);

  if (parts.length <= 2) {
    return `${raw.slice(0, 25)}…`;
  }

  return `…/${parts[parts.length - 1] ?? ""}`;
}

function splitBar(left: string, right: string, cols: number): string {
  const gap = 2;
  const rightPlain = stripSgr(right);
  const rightW = displayWidth(rightPlain);

  if (rightW === 0) {
    return padOrSlice(left, cols);
  }

  if (rightW + gap >= cols) {
    return padOrSlice(right, cols);
  }

  const leftBudget = cols - rightW - gap;
  const leftFitted = padOrSlice(left, leftBudget);
  const leftW = displayWidth(stripSgr(leftFitted));
  const pad = Math.max(gap, cols - leftW - rightW);

  return `${leftFitted}${" ".repeat(pad)}${right}`;
}

function padOrSlice(line: string, cols: number): string {
  const plain = stripSgr(line);
  const width = displayWidth(plain);

  if (width === cols) {
    return line;
  }

  if (width < cols) {
    return `${line}${" ".repeat(cols - width)}`;
  }

  return sliceToWidth(plain, cols).text;
}

/** Pad or truncate so the visible width is exactly `cols`. */
function exactCols(line: string, cols: number): string {
  if (cols <= 0) {
    return "";
  }

  const fitted = padOrSlice(line, cols);
  const width = displayWidth(stripSgr(fitted));

  if (width === cols) {
    return fitted;
  }

  if (width < cols) {
    return `${fitted}${" ".repeat(cols - width)}`;
  }

  return sliceToWidth(stripSgr(fitted), cols).text;
}
