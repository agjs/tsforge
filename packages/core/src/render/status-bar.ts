import type { IStatusInfo } from "./render.types";
import { STYLE, paint } from "./style";

const ESC = "\x1b";

/** Rows reserved at the bottom: a top border rule + the segments line. */
const RESERVED_ROWS = 2;

/** Below this height, a 2-row bar would crowd the conversation — fall back to inline. */
const MIN_ROWS = 5;

/** Cells in the context meter. */
const METER_CELLS = 9;

/** The minimal terminal surface the bar needs — matches `process.stdout` but is
 *  injectable so the controller is testable without a real TTY. */
export interface IStatusBarTerminal {
  readonly isTTY?: boolean;
  readonly rows?: number;
  readonly columns?: number;
  write(data: string): boolean;
}

/** A bar segment: visible text plus the ANSI color code to paint it with. */
interface ISegment {
  readonly text: string;
  readonly code: string;
}

/** Compact seconds/minutes for the elapsed segment. */
function humanSeconds(ms: number): string {
  const total = Math.round(ms / 1000);

  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** The context-usage meter, colored green / amber / red by fill. */
function meterSegment(info: IStatusInfo): ISegment {
  const pct =
    info.contextWindow > 0
      ? Math.round((info.contextTokens / info.contextWindow) * 100)
      : 0;
  const filled = Math.max(
    0,
    Math.min(METER_CELLS, Math.round((pct / 100) * METER_CELLS))
  );
  const code = pct >= 90 ? STYLE.red : pct >= 70 ? STYLE.yellow : STYLE.green;

  return {
    text: `▕${"█".repeat(filled)}${"░".repeat(METER_CELLS - filled)}▏ ${pct}%`,
    code,
  };
}

/** Glyph + color for the run outcome. */
function statusSegment(status: string): ISegment {
  if (status === "ready" || status === "done" || status === "responded") {
    return { text: `✓ ${status}`, code: STYLE.green };
  }

  if (status === "stuck") {
    return { text: `✗ ${status}`, code: STYLE.red };
  }

  return { text: `● ${status}`, code: STYLE.yellow };
}

/** The ordered segments shown on the bar (model, meter, tok/s, turns, status, scope). */
function barSegments(info: IStatusInfo): ISegment[] {
  const segs: ISegment[] = [
    { text: info.model, code: STYLE.brand },
    meterSegment(info),
  ];

  if (info.tokensPerSecond !== undefined && info.tokensPerSecond > 0) {
    segs.push({
      text: `⚡ ${info.tokensPerSecond} tok/s`,
      code: STYLE.brandLight,
    });
  }

  if (info.turns > 0) {
    segs.push({
      text: `↻ ${info.turns}·${humanSeconds(info.elapsedMs)}`,
      code: STYLE.dim,
    });
  }

  segs.push(statusSegment(info.status));
  segs.push({ text: info.scope, code: STYLE.dim });

  return segs;
}

/** Join segments left-to-right within `columns`, dropping whole segments that
 *  don't fit (never cuts mid-escape). Returns the painted line. */
function assemble(segs: ISegment[], columns: number, color: boolean): string {
  const sep = "  ";
  let painted = "";
  let width = 1; // leading space

  for (const seg of segs) {
    const add = (painted.length > 0 ? sep.length : 0) + seg.text.length;

    if (width + add > columns) {
      break;
    }

    painted +=
      (painted.length > 0 ? sep : "") + paint(seg.text, seg.code, color);
    width += add;
  }

  return ` ${painted}`;
}

/** A dim rule with a leading corner tick, spanning the width. */
function topBorder(columns: number, color: boolean): string {
  return paint(`╶${"─".repeat(Math.max(0, columns - 3))}`, STYLE.dim, color);
}

/**
 * The escape sequence that paints the boxed bar on the reserved bottom TWO rows
 * WITHOUT moving the user's cursor: save → border row → segments row → restore.
 * Pure and width-aware, so it can be asserted in tests with no terminal.
 */
export function buildBarFrame(
  info: IStatusInfo,
  columns: number,
  rows: number,
  color: boolean
): string {
  const borderRow = rows - 1;
  const segs = assemble(barSegments(info), columns, color);

  return (
    `${ESC}7` + // save cursor
    `${ESC}[${borderRow};1H${ESC}[2K${topBorder(columns, color)}` +
    `${ESC}[${rows};1H${ESC}[2K${segs}` +
    `${ESC}8` // restore cursor
  );
}

/**
 * An always-visible status bar pinned to the terminal's bottom via an ANSI scroll
 * region (DECSTBM). Streaming output and readline input scroll in the region
 * above it; the bar is repainted on state changes and resize. Inactive (no-op)
 * whenever the output isn't a usable TTY — the CLI then prints the inline
 * `renderStatus` line instead, so pipes and `--log` are unaffected.
 */
export class StatusBar {
  private installed = false;

  constructor(
    private readonly out: IStatusBarTerminal,
    private readonly enabled = true,
    private readonly color = true
  ) {}

  /** Whether the bar is currently pinned (false ⇒ caller uses the inline line). */
  get active(): boolean {
    return this.installed;
  }

  private canActivate(): boolean {
    return (
      this.enabled &&
      this.out.isTTY === true &&
      (this.out.rows ?? 0) >= MIN_ROWS
    );
  }

  /** Reserve the bottom rows and draw the bar. No-op if it can't activate. */
  install(info: IStatusInfo): void {
    if (this.installed || !this.canActivate()) {
      return;
    }

    const rows = this.out.rows ?? 0;

    this.out.write("\n".repeat(RESERVED_ROWS)); // make room for the bar
    this.out.write(`${ESC}[1;${rows - RESERVED_ROWS}r`); // confine scrolling
    this.out.write(`${ESC}[${rows - RESERVED_ROWS};1H`); // cursor back in-region
    this.installed = true;
    this.update(info);
  }

  /** Repaint the bar with the latest state. */
  update(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    this.out.write(
      buildBarFrame(
        info,
        this.out.columns ?? 80,
        this.out.rows ?? 0,
        this.color
      )
    );
  }

  /** Re-apply the scroll region after a terminal resize, then repaint. */
  resize(info: IStatusInfo): void {
    if (!this.installed) {
      return;
    }

    this.out.write(`${ESC}[1;${(this.out.rows ?? 0) - RESERVED_ROWS}r`);
    this.update(info);
  }

  /** Reset the scroll region, clear the bar rows, and show the cursor. Idempotent. */
  teardown(): void {
    if (!this.installed) {
      return;
    }

    const rows = this.out.rows ?? 0;

    this.out.write(`${ESC}[r`); // reset scroll region to full screen
    this.out.write(`${ESC}[${rows - 1};1H${ESC}[2K`); // clear border row
    this.out.write(`${ESC}[${rows};1H${ESC}[2K`); // clear segments row
    this.out.write(`${ESC}[?25h`); // ensure the cursor is visible
    this.installed = false;
  }
}
