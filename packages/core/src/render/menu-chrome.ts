/**
 * Shared overlay-menu chrome for the pane console.
 *
 * Every interactive overlay (/, /help, /config, @ picker, setup/scaffold) paints
 * through {@link formatOverlayShell} + {@link formatMenuRow} so selection,
 * rules, and footers stay one dialect — CONSOLE greens, not StatusBar-era cyan ›.
 */
import { CONSOLE } from "./frame/chrome";
import { STYLE, paint } from "./style";
import { displayWidth, sliceToWidth } from "./width";

/** Selection gutter width: `▸ ` / `  `. */
export const MENU_GUTTER_COLS = 2;

/** Default list-menu key hints. */
export const MENU_FOOTER_NAV = "↑/↓ move · enter select · esc close";

/** Clip to a display-column budget, grapheme-safe. */
export function menuClip(text: string, max: number): string {
  return sliceToWidth(text, max).text;
}

/** Hairline rule at content width — CONSOLE.rule (chrome gray). */
export function menuRule(columns: number, color: boolean): string {
  const width = Math.max(0, columns);

  return paint("─".repeat(width), CONSOLE.rule, color);
}

/** Dim footer line, clipped to width. */
export function menuFooter(
  text: string,
  columns: number,
  color: boolean
): string {
  return paint(menuClip(text, Math.max(0, columns)), CONSOLE.muted, color);
}

/** Quiet scroll cue (`↑ N more` / `↓ N more`). */
export function menuScrollCue(
  direction: "up" | "down",
  count: number,
  color: boolean
): string {
  const arrow = direction === "up" ? "↑" : "↓";

  return `  ${paint(`${arrow} ${String(count)} more`, CONSOLE.muted, color)}`;
}

/**
 * One selectable row: `▸ label          hint` when active (green), plain when not.
 * Fitted to width BEFORE coloring so clipping never cuts an ANSI escape.
 */
export function formatMenuRow(opts: {
  readonly label: string;
  readonly hint?: string;
  readonly active: boolean;
  readonly columns: number;
  readonly color: boolean;
  /** Prefix inside the gutter body (e.g. `◉ ` / `◯ ` for multi-select). */
  readonly marker?: string;
}): string {
  const width = Math.max(0, opts.columns);
  const avail = Math.max(0, width - MENU_GUTTER_COLS);
  const marker = opts.marker ?? "";
  const markerCols = displayWidth(marker);
  const hint = opts.hint ?? "";
  let body: string;

  if (hint.length > 0) {
    const shownHint = menuClip(hint, Math.floor(avail / 2));
    const labelMax = Math.max(
      0,
      avail - markerCols - displayWidth(shownHint) - 1
    );
    const shownLabel = menuClip(opts.label, labelMax);
    const gap = Math.max(
      1,
      avail - markerCols - displayWidth(shownLabel) - displayWidth(shownHint)
    );

    body = `${marker}${shownLabel}${" ".repeat(gap)}${shownHint}`;
  } else {
    body = `${marker}${menuClip(opts.label, Math.max(0, avail - markerCols))}`;
  }

  const gutter = opts.active ? "▸" : " ";
  const raw = `${gutter} ${body}`;

  if (!opts.active) {
    return raw;
  }

  return paint(raw, CONSOLE.bright, opts.color);
}

export interface IOverlayShellOpts {
  readonly title: string;
  /** Optional second header line (e.g. `Step 1 of 3 · Naming`). */
  readonly subtitle?: string;
  /** Already-windowed content rows (scroll cues, options, sections). */
  readonly bodyLines: readonly string[];
  /** Selected-item blurb under a rule (list menus). */
  readonly describe?: string;
  readonly footer: string;
  readonly columns: number;
  readonly color: boolean;
  /** Default {@link STYLE.bold}; wizards pass {@link STYLE.brand}. */
  readonly titleStyle?: string;
}

/**
 * Compose a complete overlay block: title → subtitle? → body → rule+describe? → footer.
 * Pure / width-aware for unit tests without a terminal.
 */
export function formatOverlayShell(opts: IOverlayShellOpts): string[] {
  const width = Math.max(20, opts.columns);
  const titleStyle = opts.titleStyle ?? STYLE.bold;
  const lines: string[] = [
    paint(menuClip(opts.title, width), titleStyle, opts.color),
  ];

  if (opts.subtitle !== undefined && opts.subtitle.length > 0) {
    lines.push(menuClip(opts.subtitle, width));
  }

  for (const line of opts.bodyLines) {
    lines.push(line);
  }

  if (opts.describe !== undefined) {
    lines.push(menuRule(width, opts.color));
    lines.push(menuClip(opts.describe, width));
  }

  lines.push(menuFooter(opts.footer, width, opts.color));

  return lines;
}

/**
 * Window a flat list so `cursor` stays visible within `visible` rows.
 * Returns the slice bounds (end exclusive).
 */
export function menuWindow(
  count: number,
  cursor: number,
  visible: number
): { start: number; end: number } {
  if (count <= 0 || visible <= 0) {
    return { start: 0, end: 0 };
  }

  const cap = Math.max(1, visible);
  const windowTop = Math.max(0, cursor - Math.floor(cap / 2));
  const end = Math.min(count, windowTop + cap);
  const start = Math.max(0, end - cap);

  return { start, end };
}

/**
 * How many body option rows fit in an overlay budget after shell chrome.
 * `budget` is total overlay rows available (pane chrome budget).
 * Fixed chrome: title + rule + describe + footer (+ optional subtitle).
 */
export function menuBodyBudget(
  overlayBudget: number,
  opts: { readonly hasSubtitle?: boolean; readonly hasDescribe?: boolean } = {}
): number {
  const budget = overlayBudget > 0 ? overlayBudget : 24;
  // title + footer + (subtitle?) + (rule+describe?) + up to 2 scroll cues
  let chrome = 2; // title + footer

  if (opts.hasSubtitle === true) {
    chrome += 1;
  }

  if (opts.hasDescribe !== false) {
    chrome += 2; // rule + describe
  }

  chrome += 2; // reserve for ↑/↓ cues

  return Math.max(1, budget - chrome);
}
