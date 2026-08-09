/** Strip SGR color codes so cell-grid paint never treats escapes as glyphs. */
export function stripSgr(text: string): string {
  const esc = String.fromCharCode(27);

  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "gu"), "");
}

/**
 * Drop SGR mouse-report sequences (`CSI < btn ; x ; y M/m`). Used when mouse
 * tracking is on (or leftover from a prior session) so clicks don't insert
 * garbage into the editor buffer.
 */
export function stripMouseReports(text: string): string {
  const esc = String.fromCharCode(27);

  return text.replace(new RegExp(`${esc}\\[<\\d+;\\d+;\\d+[Mm]`, "gu"), "");
}

/** One SGR mouse report (`CSI < btn ; col ; row M|m`), 1-based col/row. */
export interface IMouseReport {
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly release: boolean;
}

/** Parse a single SGR mouse report; null if `seq` is not exactly one. */
export function parseMouseReport(seq: string): IMouseReport | null {
  const esc = String.fromCharCode(27);
  const m = new RegExp(`^${esc}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`, "u").exec(seq);

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

/** Extract every SGR mouse report from a chunk (order preserved). */
export function extractMouseReports(text: string): IMouseReport[] {
  const esc = String.fromCharCode(27);
  const re = new RegExp(`${esc}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "gu");
  const out: IMouseReport[] = [];

  for (const m of text.matchAll(re)) {
    out.push({
      button: Number(m[1]),
      col: Number(m[2]),
      row: Number(m[3]),
      release: m[4] === "m",
    });
  }

  return out;
}
