import type { IErrorItem } from "../../validate/validate.types";
import { ruleDoc } from "../feedback/rule-docs";
import { stripSgr } from "../../render/frame/ansi-plain";
import { CONSOLE } from "../../render/frame/chrome";
import { linkifyFileLine } from "../../render/osc8-link";
import { paint } from "../../render/style";
import { displayWidth, sliceToWidth } from "../../render/width";
import type { IGateRailView } from "../session-gate-view";

export interface IFormatGateLinesOptions {
  readonly maxRows?: number;
  readonly selectedIndex?: number;
  readonly showSelection?: boolean;
  readonly columns?: number;
  readonly color?: boolean;
  readonly cwd?: string;
  readonly linkify?: boolean;
}

const MARK = "[ ]";

/** Steer prompt inserted when the user presses Enter on a gate row. */
export function gateSteerText(e: IErrorItem): string {
  const loc =
    e.file !== undefined && e.line !== undefined
      ? ` at ${e.file}:${e.line}`
      : "";
  const rule = e.rule ?? e.key;

  return `fix ${rule}${loc}`;
}

/** Header right-side count text for the Gate rail title chrome. */
export function gateRailBadge(view: IGateRailView): string {
  if (!view.gateConfigured) {
    return "";
  }

  const n = view.errorCount;

  if (n === 0) {
    return "0";
  }

  const cp = view.nearGreenCheckpoint;

  if (cp !== undefined && cp > 0 && n > cp) {
    return `${String(n)} → ${String(cp)}`;
  }

  return String(n);
}

function clip(text: string, max: number): string {
  return sliceToWidth(text, max).text;
}

function ruleLabel(e: IErrorItem): string {
  return e.rule ?? e.key;
}

function locLabel(e: IErrorItem): string {
  if (e.file === undefined) {
    return "";
  }

  const line = e.line !== undefined ? `:${String(e.line)}` : "";

  return `${e.file}${line}`;
}

function compareErrors(a: IErrorItem, b: IErrorItem): number {
  const ar = ruleLabel(a);
  const br = ruleLabel(b);

  if (ar !== br) {
    return ar.localeCompare(br);
  }

  return locLabel(a).localeCompare(locLabel(b));
}

function formatRow(
  e: IErrorItem,
  columns: number,
  color: boolean,
  cwd: string,
  linkify: boolean
): string {
  const rule = ruleLabel(e);
  const loc = locLabel(e);
  const sep = loc.length > 0 ? " — " : "";
  const lead = `${MARK} ${rule}${sep}`;
  const leadCols = displayWidth(lead);
  const budget = Math.max(4, columns - leadCols);
  let tail = loc;

  if (tail.length > 0 && linkify) {
    tail = linkifyFileLine(tail, cwd);
  }

  const body = clip(tail, budget);
  const paintedMark = paint(MARK, CONSOLE.warn, color);
  const paintedRule = paint(rule, CONSOLE.fg, color);
  const paintedSep = paint(sep, CONSOLE.muted, color);
  const paintedBody = paint(body, CONSOLE.soft, color);

  return `${paintedMark} ${paintedRule}${paintedSep}${paintedBody}`;
}

function formatRuleDocBlock(
  e: IErrorItem,
  columns: number,
  color: boolean
): string[] {
  const rule = e.rule;

  if (rule === undefined) {
    return [];
  }

  const doc = ruleDoc(rule);

  if (doc === undefined) {
    return [];
  }

  const what = clip(doc.what, columns);
  const lines = [paint(what, CONSOLE.muted, color)];

  if (doc.bad.length > 0 && doc.good.length > 0) {
    lines.push(
      paint(
        `  ✗ ${clip(doc.bad.split("\n")[0] ?? "", columns - 4)}`,
        CONSOLE.warn,
        color
      )
    );
    lines.push(
      paint(
        `  ✓ ${clip(doc.good.split("\n")[0] ?? "", columns - 4)}`,
        CONSOLE.green,
        color
      )
    );
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

    return paint(`▸ ${plain}`, CONSOLE.bright, color);
  });
}

/**
 * Gate-rail body — sorted error rows + optional rule doc for the selected item.
 * Sticky `Gate N` (or N → checkpoint) owns the chrome title.
 */
export function formatGateLines(
  view: IGateRailView,
  opts: IFormatGateLinesOptions = {}
): string[] {
  const columns = Math.max(12, opts.columns ?? 36);
  const color = opts.color !== false;
  const cwd = opts.cwd ?? ".";
  const linkify = opts.linkify !== false;

  if (!view.gateConfigured) {
    return [paint("(no gate configured)", CONSOLE.muted, color)];
  }

  if (view.errors.length === 0) {
    return [paint("no gate errors", CONSOLE.muted, color)];
  }

  const sorted = [...view.errors].sort(compareErrors);
  const maxRows = opts.maxRows ?? sorted.length;
  const shown = sorted.slice(0, maxRows);
  const lines = shown.map((e) => formatRow(e, columns, color, cwd, linkify));

  if (sorted.length > shown.length) {
    lines.push(
      paint(
        `… +${String(sorted.length - shown.length)} more`,
        CONSOLE.muted,
        color
      )
    );
  }

  const sel = opts.selectedIndex;

  if (
    opts.showSelection === true &&
    sel !== undefined &&
    sel >= 0 &&
    sel < shown.length
  ) {
    const selected = shown[sel];

    if (selected !== undefined) {
      lines.push("");
      lines.push(...formatRuleDocBlock(selected, columns, color));
    }

    return applySelection(lines.slice(0, shown.length), sel, color).concat(
      lines.slice(shown.length)
    );
  }

  return lines;
}
