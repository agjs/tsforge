import type { IFeature, IGreenfieldState } from "../greenfield";
import { stripSgr } from "../../render/frame/ansi-plain";
import { CONSOLE } from "../../render/frame/chrome";
import { paint } from "../../render/style";
import { displayWidth, sliceToWidth } from "../../render/width";

export interface IFormatWorklistLinesOptions {
  /**
   * How many pending (not-yet-current) items to preview.
   * Default 12 — fill a tall rail; callers may pass panel body rows.
   */
  maxPending?: number;
  /** Highlight this line index when the panel is focused (0 = first body line). */
  selectedIndex?: number;
  /** When true, prefix the selected row with `▸ ` (skipped if the row is already current). */
  showSelection?: boolean;
  /** Wrap width for descriptions (panel inner cols). Default 36. */
  columns?: number;
  /** When false, emit plain glyphs with no SGR. Default true. */
  color?: boolean;
}

type ItemKind = "done" | "current" | "pending" | "parked";

const GLYPH: Record<ItemKind, string> = {
  done: "✓",
  current: "▸",
  pending: "○",
  parked: "~",
};

const CONT_INDENT = "  ";

/** Compact badge for the top status strip, e.g. `3/7`. */
export function worklistBadge(state: IGreenfieldState): string {
  const total = state.features.length;

  if (total === 0) {
    return "";
  }

  const done = state.features.filter((f) => f.passes).length;

  return `${done}/${total}`;
}

function clip(text: string, max: number): string {
  return sliceToWidth(text, max).text;
}

function pushHardBroken(word: string, budget: number, lines: string[]): string {
  let rest = word;

  while (rest.length > 0 && displayWidth(rest) > budget) {
    const cut = sliceToWidth(rest, budget);

    if (cut.text.length === 0) {
      break;
    }

    lines.push(cut.text);
    rest = rest.slice(cut.text.length);
  }

  return rest;
}

/** Soft-wrap `text` to `budget` columns (word-aware, grapheme-safe). */
function wrapWords(text: string, budget: number): string[] {
  if (budget <= 0) {
    return [];
  }

  if (displayWidth(text) <= budget) {
    return [text];
  }

  const words = text.split(/\s+/u).filter((w) => w.length > 0);

  if (words.length === 0) {
    return [clip(text, budget)];
  }

  const lines: string[] = [];
  let cur = "";

  for (const word of words) {
    const next = cur.length === 0 ? word : `${cur} ${word}`;

    if (displayWidth(next) <= budget) {
      cur = next;
      continue;
    }

    if (cur.length > 0) {
      lines.push(cur);
    }

    cur =
      displayWidth(word) <= budget ? word : pushHardBroken(word, budget, lines);
  }

  if (cur.length > 0) {
    lines.push(cur);
  }

  return lines.length > 0 ? lines : [clip(text, budget)];
}

function paintGlyph(glyph: string, kind: ItemKind, color: boolean): string {
  if (!color) {
    return glyph;
  }

  if (kind === "current") {
    return paint(glyph, CONSOLE.bright, true);
  }

  if (kind === "parked") {
    return paint(glyph, CONSOLE.warn, true);
  }

  return paint(glyph, CONSOLE.muted, true);
}

function paintBody(part: string, kind: ItemKind, color: boolean): string {
  if (!color) {
    return part;
  }

  if (kind === "current") {
    return paint(part, CONSOLE.bright, true);
  }

  if (kind === "parked") {
    return part;
  }

  return paint(part, CONSOLE.muted, true);
}

/** One item: glyph + wrapped description (continuations indented). */
function formatItemLines(
  feature: IFeature,
  kind: ItemKind,
  columns: number,
  color: boolean
): string[] {
  const glyph = GLYPH[kind];
  const painted = paintGlyph(glyph, kind, color);
  const budget = Math.max(4, columns - displayWidth(`${glyph} `));
  const parts = wrapWords(feature.desc.trim(), budget);

  return parts.map((part, i) => {
    const body = paintBody(part, kind, color);

    return i === 0 ? `${painted} ${body}` : `${CONT_INDENT}${body}`;
  });
}

function applySelection(
  lines: readonly string[],
  selectedIndex: number,
  color: boolean
): string[] {
  return lines.map((line, i) => {
    if (i !== selectedIndex) {
      return `  ${line}`;
    }

    const plain = stripSgr(line);

    if (plain.startsWith(GLYPH.current)) {
      return line;
    }

    return paint(`▸ ${plain}`, CONSOLE.bright, color);
  });
}

/**
 * Tasks-rail body lines — goal cue + checklist from gate state only
 * (never model narration). Sticky `Tasks N/M` title is painted separately.
 */
export function formatWorklistLines(
  state: IGreenfieldState,
  opts: IFormatWorklistLinesOptions = {}
): string[] {
  const maxPending = opts.maxPending ?? 12;
  const columns = Math.max(12, opts.columns ?? 36);
  const color = opts.color !== false;
  const total = state.features.length;

  if (total === 0) {
    return [
      paint("/work PLAN.md", CONSOLE.muted, color),
      paint("or /work <goal>", CONSOLE.muted, color),
    ];
  }

  const done = state.features.filter((f) => f.passes);
  const current = state.features.find((f) => !f.passes && !(f.parked ?? false));
  const pending = state.features.filter(
    (f) => !f.passes && !(f.parked ?? false) && f.id !== current?.id
  );
  const parked = state.features.filter((f) => (f.parked ?? false) && !f.passes);

  const lines: string[] = [];
  const goal = state.goal.trim();

  if (goal.length > 0 && goal !== "worklist") {
    lines.push(paint(clip(goal, columns), CONSOLE.muted, color));
  }

  for (const feature of done.slice(-2)) {
    lines.push(...formatItemLines(feature, "done", columns, color));
  }

  if (current !== undefined) {
    lines.push(...formatItemLines(current, "current", columns, color));
  } else if (done.length === total) {
    lines.push(paint("All done.", CONSOLE.bright, color));
  } else if (parked.length > 0) {
    lines.push(
      paint(`Parked ${String(parked.length)} — revisit`, CONSOLE.warn, color)
    );
  }

  for (const feature of pending.slice(0, maxPending)) {
    lines.push(...formatItemLines(feature, "pending", columns, color));
  }

  if (pending.length > maxPending) {
    const more = `… +${String(pending.length - maxPending)} more`;

    lines.push(paint(more, CONSOLE.muted, color));
  }

  for (const feature of parked.slice(0, 2)) {
    lines.push(...formatItemLines(feature, "parked", columns, color));
  }

  if (opts.showSelection === true && opts.selectedIndex !== undefined) {
    return applySelection(lines, opts.selectedIndex, color);
  }

  return lines;
}
