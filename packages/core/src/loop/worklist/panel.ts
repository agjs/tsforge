import type { IChecklistItem, IPlanDocument } from "./checklist.types";
import { countDone, countOpen } from "./checklist-store";
import { stripSgr } from "../../render/frame/ansi-plain";
import { CONSOLE } from "../../render/frame/chrome";
import {
  filledRoleBadge,
  roleBadgeCols,
  roleCardCols,
  roleHairline,
} from "../../render/ansi";
import { STYLE, paint } from "../../render/style";
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

type ItemKind = "done" | "current" | "pending" | "blocked";

/**
 * Bracketed status marks (3 cols) — readable in a narrow pane rail.
 * Tree connectors (`├─` / `└─`) show parent → child; color reinforces status.
 */
const GLYPH: Record<ItemKind, string> = {
  done: "[✓]",
  current: "[>]",
  pending: "[ ]",
  blocked: "[!]",
};

const CONNECT_MID = "├─ ";
const CONNECT_END = "└─ ";
const PIPE = "│  ";
const GAP = "   ";

/** Compact badge for the top status strip, e.g. `3/7`. */
export function worklistBadge(plan: IPlanDocument | null): string {
  if (plan === null || plan.items.length === 0) {
    return "";
  }

  const open = countOpen(plan.items);
  const done = countDone(plan.items);
  const total = open + done;

  if (total === 0) {
    return "";
  }

  return `${done}/${total}`;
}

/** Badge while a present_plan proposal awaits approve (not yet bound). */
export function pendingPlanBadge(plan: IPlanDocument | null): string {
  if (plan === null || plan.items.length === 0) {
    return "";
  }

  const open = countOpen(plan.items);

  return `·${String(open)}`;
}

/**
 * Closed PLAN card for the main transcript when present_plan fires —
 * goal + nested tree, no raw JSON. Soft-wraps (never mid-word clip).
 */
export function formatPlanProposal(
  plan: IPlanDocument,
  columns?: number,
  color = true
): string {
  const cols = roleCardCols(columns);
  const badge = filledRoleBadge("PLAN", color);
  const top =
    badge + roleHairline(cols, STYLE.plan, color, "┐", roleBadgeCols(badge));
  const gutter = paint("│", STYLE.plan, color);
  const right = paint("│", STYLE.plan, color);
  // Box inner between the two `│` rails; text sits in `│  …  │` (2-col pad each side).
  const boxInner = Math.max(14, cols - 2);
  const textBudget = Math.max(12, boxInner - 4);
  const lines: string[] = [top];

  const pushBlank = (): void => {
    lines.push(`${gutter}${" ".repeat(boxInner)}${right}`);
  };

  const push = (text: string, bold = false): void => {
    const parts = wrapWords(text, textBudget);

    for (const part of parts.length > 0 ? parts : [""]) {
      const body = paint(
        part,
        bold ? STYLE.plan + STYLE.bold : STYLE.plan,
        color
      );
      const pad = Math.max(0, textBudget - displayWidth(part));

      lines.push(`${gutter}  ${body}${" ".repeat(pad)}  ${right}`);
    }
  };

  pushBlank();
  push(plan.goal.trim().length > 0 ? plan.goal.trim() : "plan", true);
  pushBlank();

  const walk = (
    nodes: readonly IChecklistItem[],
    ancestorsOpen: readonly boolean[]
  ): void => {
    nodes.forEach((item, index) => {
      const isLast = index === nodes.length - 1;
      const prefix = treePrefix(ancestorsOpen, isLast);

      push(`${prefix}${GLYPH.pending} ${item.title}`);

      if (item.detail !== undefined && item.detail.trim().length > 0) {
        const detailLead = `${treeGap(ancestorsOpen, isLast)}    `;

        push(`${detailLead}${item.detail.trim()}`);
      }

      if (item.children) {
        walk(item.children, [...ancestorsOpen, !isLast]);
      }
    });
  };

  walk(plan.items, []);
  pushBlank();
  push(`type approve to build · ${String(countOpen(plan.items))} items`);
  lines.push(
    paint(`└${"─".repeat(Math.max(0, cols - 2))}┘`, STYLE.plan, color)
  );

  return lines.join("\n");
}

function treePrefix(
  ancestorsOpen: readonly boolean[],
  isLast: boolean
): string {
  let out = "";

  for (const open of ancestorsOpen) {
    out += open ? PIPE : GAP;
  }

  out += isLast ? CONNECT_END : CONNECT_MID;

  return out;
}

/** Indent under a node for wrapped extras (aligns with title text). */
function treeGap(ancestorsOpen: readonly boolean[], isLast: boolean): string {
  let out = "";

  for (const open of ancestorsOpen) {
    out += open ? PIPE : GAP;
  }

  out += isLast ? GAP : PIPE;

  return out;
}

function clip(text: string, max: number): string {
  return sliceToWidth(text, max).text;
}

/** Soft-wrap then keep at most `maxLines`; last kept line ends with … if truncated. */
function wrapClamped(text: string, budget: number, maxLines: number): string[] {
  const parts = wrapWords(text, budget);

  if (parts.length <= maxLines) {
    return parts;
  }

  const kept = parts.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  const ellipsisBudget = Math.max(1, budget - 1);
  const head = clip(last, ellipsisBudget).replace(/\s+$/u, "");

  kept[maxLines - 1] = `${head}…`;

  return kept;
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

  if (kind === "done") {
    return paint(glyph, CONSOLE.green, true);
  }

  if (kind === "current") {
    return paint(glyph, CONSOLE.bright, true);
  }

  if (kind === "blocked") {
    return paint(glyph, CONSOLE.warn, true);
  }

  return paint(glyph, CONSOLE.soft, true);
}

function paintBody(part: string, kind: ItemKind, color: boolean): string {
  if (!color) {
    return part;
  }

  if (kind === "done") {
    return paint(part, CONSOLE.muted, true);
  }

  if (kind === "current") {
    return paint(part, CONSOLE.bright, true);
  }

  if (kind === "blocked") {
    return paint(part, CONSOLE.warn, true);
  }

  return paint(part, CONSOLE.fg, true);
}

function kindOf(item: IChecklistItem, activeItemId: string | null): ItemKind {
  if (item.status === "done") {
    return "done";
  }

  if (item.status === "blocked") {
    return "blocked";
  }

  if (item.id === activeItemId || item.status === "active") {
    return "current";
  }

  return "pending";
}

/** One item: muted tree connector + status mark + wrapped title. */
function formatItemLines(
  item: IChecklistItem,
  kind: ItemKind,
  columns: number,
  color: boolean,
  ancestorsOpen: readonly boolean[],
  isLast: boolean,
  extras: readonly string[]
): string[] {
  const glyph = GLYPH[kind];
  const painted = paintGlyph(glyph, kind, color);
  const prefix = treePrefix(ancestorsOpen, isLast);
  const prefixPainted = paint(prefix, CONSOLE.muted, color);
  const leadPlain = `${prefix}${glyph} `;
  const leadCols = displayWidth(leadPlain);
  const budget = Math.max(4, columns - leadCols);
  const parts = wrapWords(item.title.trim(), budget);
  const lines = parts.map((part, i) => {
    const body = paintBody(part, kind, color);

    return i === 0
      ? `${prefixPainted}${painted} ${body}`
      : `${" ".repeat(leadCols)}${body}`;
  });

  const extraLead = `${treeGap(ancestorsOpen, isLast)}    `;
  const extraBudget = Math.max(4, columns - displayWidth(extraLead));

  for (const extra of extras) {
    for (const part of wrapWords(extra, extraBudget)) {
      lines.push(paint(`${extraLead}${part}`, CONSOLE.muted, color));
    }
  }

  return lines;
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

    if (plain.includes(GLYPH.current)) {
      return line;
    }

    return paint(`▸ ${plain}`, CONSOLE.bright, color);
  });
}

function focusExtras(item: IChecklistItem): string[] {
  const extras: string[] = [];

  if (item.verify !== undefined && item.verify.trim().length > 0) {
    extras.push(`verify: ${item.verify.trim()}`);
  }

  if (
    item.blockedReason !== undefined &&
    item.blockedReason.trim().length > 0
  ) {
    extras.push(`blocked: ${item.blockedReason.trim()}`);
  }

  return extras;
}

function walkChecklist(
  plan: IPlanDocument,
  nodes: readonly IChecklistItem[],
  ancestorsOpen: readonly boolean[],
  ctx: {
    readonly maxPending: number;
    readonly columns: number;
    readonly color: boolean;
    readonly pending: { shown: number; hidden: number };
    readonly out: string[];
  }
): void {
  nodes.forEach((item, index) => {
    const isLast = index === nodes.length - 1;
    const kind = kindOf(item, plan.activeItemId);
    const isFocus =
      kind === "current" ||
      (plan.activeItemId !== null && item.id === plan.activeItemId);

    if (kind === "pending" && !isFocus) {
      if (ctx.pending.shown >= ctx.maxPending) {
        ctx.pending.hidden += 1;

        if (item.children !== undefined) {
          walkChecklist(plan, item.children, [...ancestorsOpen, !isLast], ctx);
        }

        return;
      }

      ctx.pending.shown += 1;
    }

    ctx.out.push(
      ...formatItemLines(
        item,
        kind,
        ctx.columns,
        ctx.color,
        ancestorsOpen,
        isLast,
        isFocus ? focusExtras(item) : []
      )
    );

    if (item.children !== undefined) {
      walkChecklist(plan, item.children, [...ancestorsOpen, !isLast], ctx);
    }
  });
}

/**
 * Tasks-rail body — soft goal lead-in, hairline, then the checklist tree.
 * Sticky `Tasks N/M` owns the chrome; no repeated PLAN/TASKS labels in body.
 */
export function formatWorklistLines(
  plan: IPlanDocument | null,
  opts: IFormatWorklistLinesOptions = {}
): string[] {
  const maxPending = opts.maxPending ?? 12;
  const columns = Math.max(12, opts.columns ?? 36);
  const color = opts.color !== false;

  if (plan === null || plan.items.length === 0) {
    return [
      paint("approve a plan", CONSOLE.muted, color),
      paint("to fill this list", CONSOLE.muted, color),
    ];
  }

  const lines: string[] = [];
  const goal = plan.goal.trim();

  if (goal.length > 0) {
    // Cap so a novel-length goal cannot crowd out the checklist.
    for (const part of wrapClamped(goal, columns, 3)) {
      lines.push(paint(part, CONSOLE.soft, color));
    }

    lines.push(paint("─".repeat(columns), CONSOLE.rule, color));
    lines.push("");
  }

  const pending = { shown: 0, hidden: 0 };

  walkChecklist(plan, plan.items, [], {
    maxPending,
    columns,
    color,
    pending,
    out: lines,
  });

  if (pending.hidden > 0) {
    lines.push(
      paint(`… +${String(pending.hidden)} more`, CONSOLE.muted, color)
    );
  }

  if (opts.showSelection === true && opts.selectedIndex !== undefined) {
    return applySelection(lines, opts.selectedIndex, color);
  }

  return lines;
}
