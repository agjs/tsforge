import { isRecord } from "../lib/guards";

/** A bounded, signal-first extract of a build transcript, safe to hand to a
 *  review panel. NEVER truncates silently: whatever is dropped is counted and
 *  reported in `note`, so a reviewer knows it is seeing a summary, not the whole
 *  run. */
export interface ILogSlice {
  text: string;
  totalLines: number;
  keptLines: number;
  droppedLines: number;
  note: string;
}

/** Lines whose content names a failure/progress signal are always kept — these
 *  are the spine of the story a diagnoser needs (park reasons, gate errors,
 *  regressions, acceptance state). */
const SIGNAL =
  /parked|ladder exhausted|revisit|no-unsafe|prettier|regress|stuck|oscillat|escalat|expert|acceptance|verified|gate|error|fail|❌|✗/iu;

/** Render one parsed JSONL event as a compact single line. Falls back to the
 *  raw line for non-JSON input (plain logs), so the slicer works on both. */
function compact(line: string): {
  text: string;
  signal: boolean;
  fix: boolean;
} {
  let obj: unknown;

  try {
    obj = JSON.parse(line);
  } catch {
    return { text: line, signal: SIGNAL.test(line), fix: false };
  }

  if (!isRecord(obj)) {
    return { text: line, signal: SIGNAL.test(line), fix: false };
  }

  const kind = typeof obj.kind === "string" ? obj.kind : "?";
  const msg = typeof obj.message === "string" ? obj.message : "";
  const extra: string[] = [];

  if (typeof obj.file === "string") {
    extra.push(obj.file);
  }

  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) {
    extra.push(`exit=${String(obj.exitCode)}`);
  }

  const text = `[${kind}] ${msg}${extra.length > 0 ? ` (${extra.join(" ")})` : ""}`;

  return {
    text,
    signal: kind === "fix" || SIGNAL.test(text),
    fix: kind === "fix",
  };
}

/** Build a signal-first slice within a character budget. Priority, high→low:
 *  (1) every `fix` event and signal line, (2) the last `tailLines` events for the
 *  final state, (3) remaining budget filled with recent low-signal context.
 *  Anything not kept is counted into `droppedLines` and reported in `note`. */
interface IEntry {
  idx: number;
  text: string;
  signal: boolean;
  fix: boolean;
}

const cost = (e: IEntry): number => e.text.length + 1;

const sumCost = (entries: IEntry[]): number =>
  entries.reduce((sum, e) => sum + cost(e), 0);

export function sliceBuildLog(
  raw: string,
  opts: { maxChars: number; tailLines: number }
): ILogSlice {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const total = lines.length;
  const tailStart = Math.max(0, total - opts.tailLines);
  const entries: IEntry[] = lines.map((line, idx) => ({
    idx,
    ...compact(line),
  }));

  // Kept: signal/fix lines anywhere + everything in the tail window.
  const kept = entries.filter((e) => e.signal || e.idx >= tailStart);
  let ordered = kept;

  // If over budget, drop low-signal (non-fix, non-signal) context lines,
  // oldest first, until it fits — never drop a fix/signal line.
  if (sumCost(kept) > opts.maxChars) {
    const mustKeep = kept.filter((e) => e.signal || e.fix);
    const context = kept.filter((e) => !e.signal && !e.fix);
    let running = sumCost(mustKeep);
    const survivors: IEntry[] = [];

    for (const e of [...context].reverse()) {
      if (running + cost(e) <= opts.maxChars) {
        running += cost(e);
        survivors.push(e);
      }
    }

    ordered = [...mustKeep, ...survivors].sort((a, b) => a.idx - b.idx);
  }

  const droppedLines = total - ordered.length;
  const text = ordered.map((e) => e.text).join("\n");
  const note =
    droppedLines === 0
      ? `full transcript: ${String(total)} events, all kept`
      : `SUMMARY: kept ${String(ordered.length)} of ${String(total)} events (all park/error/signal lines + the last ${String(opts.tailLines)}); dropped ${String(droppedLines)} low-signal lines to fit the budget`;

  return {
    text,
    totalLines: total,
    keptLines: ordered.length,
    droppedLines,
    note,
  };
}
