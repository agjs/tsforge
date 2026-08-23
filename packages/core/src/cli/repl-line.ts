import { stripMouseReports } from "../render/frame/ansi-plain";

/** Leftover SGR mouse report without its ESC (`0;23;22M` / `[<0;23;22M`). */
const ORPHAN_MOUSE = /^(?:\[<)?\d+;\d+;\d+[Mm]$/u;

/**
 * Whether a submitted REPL line is a real user prompt.
 * Mouse CSI (and orphaned reports after ESC was consumed) must never dispatch
 * — they were the ghost "session starts exploring with no typed prompt."
 */
export function shouldDispatchReplLine(raw: string): boolean {
  const cleaned = stripMouseReports(raw).trim();

  if (cleaned.length === 0) {
    return false;
  }

  if (ORPHAN_MOUSE.test(cleaned)) {
    return false;
  }

  return /[A-Za-z0-9]/u.test(cleaned);
}
