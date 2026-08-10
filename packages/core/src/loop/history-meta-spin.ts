/**
 * History-meta stub-spam streak — DeepSeek re-submits redacted create/edit
 * args for dozens of turns even after a clear history-stub reject (Ledgerkit).
 * Mirror readonly-spin: resteer at N, park at M.
 */
import type { IChatMessage } from "../inference";
import { isHistoryMetaRejectContent } from "./context-hygiene";
import { isAttemptedWriteTool } from "./readonly-spin";

/** Consecutive history-meta-only turns before a sharp user inject. */
export const HISTORY_META_RESTEER_AT = 3;

/** Consecutive history-meta-only turns before parking the run. */
export const HISTORY_META_PARK_AT = 8;

/** Action-only resteer — do not copy prior tool_calls. */
export const HISTORY_META_RESTEER =
  "STOP copying prior create/edit tool_calls from history — those are stubs, " +
  "not real writes. `read` the file, then call create/edit with real `content` " +
  "or `oldString`/`newString`. Do not re-submit file-only args.";

/** True when any tool result appended this turn is a history-meta reject. */
export function turnHadHistoryMetaReject(
  messages: readonly IChatMessage[],
  messagesStartIndex: number
): boolean {
  for (let i = messagesStartIndex; i < messages.length; i += 1) {
    const m = messages[i];

    if (m?.role === "tool" && isHistoryMetaRejectContent(m.content)) {
      return true;
    }
  }

  return false;
}

/**
 * Stub-spam turn: model attempted a write, got history-meta, no successful
 * edit. Must not reset readonly-spin via attemptedWrite.
 */
export function isHistoryMetaOnlyWriteTurn(opts: {
  readonly calls: readonly { readonly name: string }[];
  readonly hadHistoryMeta: boolean;
  readonly successfulWrite: boolean;
}): boolean {
  if (opts.successfulWrite || !opts.hadHistoryMeta) {
    return false;
  }

  return opts.calls.some((c) => isAttemptedWriteTool(c.name));
}

/** Next history-meta streak after one tool turn. */
export function nextHistoryMetaStreak(opts: {
  readonly previous: number;
  readonly hadHistoryMeta: boolean;
  readonly successfulWrite: boolean;
}): number {
  if (opts.successfulWrite) {
    return 0;
  }

  if (opts.hadHistoryMeta) {
    return opts.previous + 1;
  }

  return opts.previous;
}

/** Keep streak at the resteer threshold so the next meta reject can climb to park. */
export function streakAfterHistoryMetaResteer(): number {
  return HISTORY_META_RESTEER_AT;
}
