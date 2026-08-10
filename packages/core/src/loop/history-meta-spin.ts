/**
 * Malformed create/edit thrash guard.
 *
 * DeepSeek copies redacted/empty write tool_calls (Ledgerkit history-meta,
 * Reservely L3-re-ask storm → 1000-turn runaway). Soft text alone does not
 * stop it. Count consecutive turns with a bad write reject and no successful
 * write: resteer once, then park. Never let these turns reset readonly-spin.
 */
import type { IChatMessage } from "../inference";
import { isHistoryMetaRejectContent } from "./context-hygiene";
import { isAttemptedWriteTool } from "./readonly-spin";

/** Consecutive bad-write-only turns before a sharp user inject. */
export const HISTORY_META_RESTEER_AT = 3;

/**
 * Consecutive bad-write-only turns before parking.
 * Reservely continue: ~50 L3/min with zero successful writes — must stop.
 * Only fires after a dry streak (successful write resets to 0).
 */
export const HISTORY_META_PARK_AT = 12;

/** Action-only resteer — do not copy prior tool_calls. */
export const HISTORY_META_RESTEER =
  "STOP copying prior create/edit tool_calls from history — those are stubs " +
  "or incomplete. `read` the file, then call create/edit with real `content` " +
  "or `oldString`/`newString`. Empty `{}` / file-only args are not valid writes.";

/** True when a tool result is a history-meta or L3 create/edit reject. */
export function isMalformedWriteRejectContent(content: string): boolean {
  if (isHistoryMetaRejectContent(content)) {
    return true;
  }

  return (
    content.includes("malformed args") ||
    content.includes("Tool argument repair failed")
  );
}

/** True when any tool result appended this turn is a malformed write reject. */
export function turnHadHistoryMetaReject(
  messages: readonly IChatMessage[],
  messagesStartIndex: number
): boolean {
  for (let i = messagesStartIndex; i < messages.length; i += 1) {
    const m = messages[i];

    if (m?.role === "tool" && isMalformedWriteRejectContent(m.content)) {
      return true;
    }
  }

  return false;
}

/**
 * Stub/L3 spam turn: model attempted a write, got a malformed reject, no
 * successful edit. Must not reset readonly-spin via attemptedWrite.
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

/** Next bad-write streak after one tool turn. */
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

/**
 * After resteer, bump past the threshold so the next bad turn does not
 * re-inject (Reservely logged repeated resteers at === RESTEER_AT).
 */
export function streakAfterHistoryMetaResteer(): number {
  return HISTORY_META_RESTEER_AT + 1;
}
