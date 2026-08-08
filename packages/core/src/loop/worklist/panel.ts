import type { IFeature, IGreenfieldState } from "../greenfield";

export interface IFormatWorklistLinesOptions {
  /** How many pending (not-yet-current) items to preview. Default 3. */
  maxPending?: number;
  /** Highlight this line index when the panel is focused (0 = header). */
  selectedIndex?: number;
  /** When true, prefix the selected row with `▸ `. */
  showSelection?: boolean;
}

function boxOf(feature: IFeature, current: boolean): string {
  if (feature.passes) {
    return "[x]";
  }

  if (feature.parked === true) {
    return "[~]";
  }

  if (current) {
    return "[>]";
  }

  return "[ ]";
}

/** Compact badge for the top status strip, e.g. `3/7`. */
export function worklistBadge(state: IGreenfieldState): string {
  const total = state.features.length;

  if (total === 0) {
    return "";
  }

  const done = state.features.filter((f) => f.passes).length;

  return `${done}/${total}`;
}

/**
 * Compact live-region / panel lines for the worklist — counts and checkmarks
 * from gate state only (never model narration).
 */
export function formatWorklistLines(
  state: IGreenfieldState,
  opts: IFormatWorklistLinesOptions = {}
): string[] {
  const maxPending = opts.maxPending ?? 3;
  const total = state.features.length;

  if (total === 0) {
    return ["worklist", "/work to start"];
  }

  const done = state.features.filter((f) => f.passes).length;
  const current = state.features.find((f) => !f.passes && !(f.parked ?? false));
  const pending = state.features.filter(
    (f) => !f.passes && !(f.parked ?? false) && f.id !== current?.id
  );
  const parked = state.features.filter((f) => (f.parked ?? false) && !f.passes);

  const lines: string[] = [`worklist  ${done}/${total}`];

  if (current !== undefined) {
    lines.push(`${boxOf(current, true)} ${current.desc}`);
  } else if (done === total) {
    lines.push("All done.");
  } else if (parked.length > 0) {
    lines.push(`Parked ${parked.length} — revisit`);
  }

  for (const feature of pending.slice(0, maxPending)) {
    lines.push(`${boxOf(feature, false)} ${feature.desc}`);
  }

  if (pending.length > maxPending) {
    lines.push(`… +${pending.length - maxPending} more`);
  }

  if (opts.showSelection === true && opts.selectedIndex !== undefined) {
    const idx = opts.selectedIndex;

    return lines.map((line, i) => (i === idx ? `▸ ${line}` : `  ${line}`));
  }

  return lines;
}
