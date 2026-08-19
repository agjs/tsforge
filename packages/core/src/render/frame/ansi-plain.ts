/** Hoisted: this runs on the innermost per-row paint loop (~200×/frame), and
 *  compiling a fresh RegExp per call was a measurable share of frame cost.
 *  Global-flag `lastIndex` is reset by String.replace, so sharing is safe. */
const SGR_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/** Strip SGR color codes so cell-grid paint never treats escapes as glyphs. */
export function stripSgr(text: string): string {
  return text.replace(SGR_CODES, "");
}

const MOUSE_REPORT_G = new RegExp(
  `${String.fromCharCode(27)}\\[<\\d+;\\d+;\\d+[Mm]`,
  "gu"
);
const ORPHAN_MOUSE_REPORT_G = /\[<\d+;\d+;\d+[Mm]/gu;

/**
 * Drop SGR mouse-report sequences (`CSI < btn ; x ; y M/m`). Used when mouse
 * tracking is on (or leftover from a prior session) so clicks don't insert
 * garbage into the editor buffer. Also strips orphaned tails (`[<…M`) when the
 * leading ESC was already consumed by a prior chunk.
 */
export function stripMouseReports(text: string): string {
  return text.replace(MOUSE_REPORT_G, "").replace(ORPHAN_MOUSE_REPORT_G, "");
}

/** One SGR mouse report (`CSI < btn ; col ; row M|m`), 1-based col/row. */
export interface IMouseReport {
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly release: boolean;
}

const ONE_MOUSE_REPORT = new RegExp(
  `^${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`,
  "u"
);

/** Parse a single SGR mouse report; null if `seq` is not exactly one. */
export function parseMouseReport(seq: string): IMouseReport | null {
  const m = ONE_MOUSE_REPORT.exec(seq);

  if (m === null) {
    return null;
  }

  return {
    button: Number(m[1]),
    col: Number(m[2]),
    row: Number(m[3]),
    release: m[4] === "m",
  };
}

const ALL_MOUSE_REPORTS = new RegExp(
  `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
  "gu"
);

/** Extract every SGR mouse report from a chunk (order preserved). */
export function extractMouseReports(text: string): IMouseReport[] {
  const out: IMouseReport[] = [];

  for (const m of text.matchAll(ALL_MOUSE_REPORTS)) {
    out.push({
      button: Number(m[1]),
      col: Number(m[2]),
      row: Number(m[3]),
      release: m[4] === "m",
    });
  }

  return out;
}

export interface IMouseCsiFeed {
  /** Complete reports (always with leading ESC) for PaneScreen.handleKey. */
  readonly reports: readonly string[];
  /** Bytes safe to hand the editor / focus keys. */
  readonly cleaned: string;
  /** True when a trailing ESC/CSI mouse prefix is held for the next chunk. */
  readonly holding: boolean;
}

export interface IMouseCsiFilter {
  feed(chunk: string): IMouseCsiFeed;
  /** Emit held bytes as cleaned (Esc timeout / teardown). */
  flush(): IMouseCsiFeed;
  reset(): void;
}

const ESC = String.fromCharCode(27);
/** Sticky (`y`) so the scan can match AT an index without slicing the whole
 *  remainder per character — the old `input.slice(i)` + `^`-anchored regexes
 *  made a large paste O(n²). */
const FULL_REPORT_AT = new RegExp(`${ESC}\\[<\\d+;\\d+;\\d+[Mm]`, "yu");
const ORPHAN_REPORT_AT = /\[<\d+;\d+;\d+[Mm]/uy;
/** Prefix that can still grow into a full `\x1b[<b;x;yM` (or orphan without ESC). */
const HOLD_PREFIX = new RegExp(
  `^(?:${ESC}(?:\\[(?:<(?:\\d+(?:;(?:\\d+(?:;\\d*)?)?)?)?)?)?|\\[<(?:\\d+(?:;(?:\\d+(?:;\\d*)?)?)?)?)$`,
  "u"
);
/** A growable report prefix is at most `[<65535;65535;65535` + ESC — anything
 *  longer than this at the tail cannot be a hold. Bounds the tail slice. */
const MAX_HOLD_PREFIX = 24;

function isMouseHold(rest: string): boolean {
  return rest.length > 0 && HOLD_PREFIX.test(rest);
}

/**
 * Reassemble SGR mouse reports that arrive split across stdin chunks.
 * Without this, a lone ESC is peeled off and `[<65;96;52M` is typed into the
 * prompt — the exact garbage users see while scrolling the pane TUI.
 */
export function createMouseCsiFilter(): IMouseCsiFilter {
  let pending = "";

  const empty = (): IMouseCsiFeed => ({
    reports: [],
    cleaned: "",
    holding: false,
  });

  /** End of the plain-text span starting at `i` (up to the next ESC or '['). */
  const plainSpanEnd = (input: string, i: number): number => {
    let j = i + 1;

    while (j < input.length) {
      const c = input.charCodeAt(j);

      if (c === 27 || c === 0x5b) {
        break;
      }

      j += 1;
    }

    return j;
  };

  /** Report matched AT `i`, rendered with its leading ESC; null if none. */
  const reportAt = (input: string, i: number, code: number): string | null => {
    if (code === 27) {
      FULL_REPORT_AT.lastIndex = i;

      return FULL_REPORT_AT.exec(input)?.[0] ?? null;
    }

    ORPHAN_REPORT_AT.lastIndex = i;
    const orphan = ORPHAN_REPORT_AT.exec(input)?.[0];

    return orphan === undefined ? null : `${ESC}${orphan}`;
  };

  const run = (input: string): IMouseCsiFeed => {
    const reports: string[] = [];
    let cleaned = "";
    let i = 0;

    while (i < input.length) {
      const code = input.charCodeAt(i);

      // Plain text (neither ESC nor '[') can never start a report — bulk-copy
      // the whole span in one slice instead of char-by-char through the regexes.
      if (code !== 27 && code !== 0x5b) {
        const j = plainSpanEnd(input, i);

        cleaned += input.slice(i, j);
        i = j;
        continue;
      }

      const report = reportAt(input, i, code);

      if (report !== null) {
        reports.push(report);
        // Orphans carry a prepended ESC that is not in the input.
        i += code === 27 ? report.length : report.length - 1;
        continue;
      }

      // A hold is a report prefix cut off by the chunk boundary — it can only
      // live in the last few bytes, so the tail slice is bounded.
      if (input.length - i <= MAX_HOLD_PREFIX && isMouseHold(input.slice(i))) {
        pending = input.slice(i);
        break;
      }

      cleaned += input[i] ?? "";
      i += 1;
    }

    return {
      reports,
      cleaned,
      holding: pending.length > 0,
    };
  };

  return {
    feed(chunk: string): IMouseCsiFeed {
      const input = pending + chunk;

      pending = "";

      return run(input);
    },
    flush(): IMouseCsiFeed {
      if (pending.length === 0) {
        return empty();
      }

      // Incomplete mouse prefix after timeout — drop it (never type into prompt).
      // A bare ESC is a real Escape keypress.
      const held = pending;

      pending = "";

      if (held === ESC) {
        return { reports: [], cleaned: ESC, holding: false };
      }

      if (held.startsWith(ESC) && !held.includes("<")) {
        // `\x1b` or `\x1b[` that never became a mouse report — pass through.
        return { reports: [], cleaned: held, holding: false };
      }

      return empty();
    },
    reset(): void {
      pending = "";
    },
  };
}
