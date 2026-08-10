/**
 * Read-only-spin streak math — shared by Session and headless runTask.
 *
 * Soft text re-steers do nothing on DeepSeek (Shiphold: same 3-file read loop
 * after every nudge). Rules:
 * - Successful write OR attempted write tool → streak 0
 * - Otherwise → +1 (including re-reads; no "survey grace" — that let loops run)
 * - After a re-steer, callers MUST keep the streak high and force write tools
 */
import { TOOL_NAME } from "../agent/agent.constants";

/** Tools that count as "tried to mutate" even when args/policy reject. */
export const WRITE_ATTEMPT_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME.create,
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
  TOOL_NAME.renameSymbol,
  TOOL_NAME.moveFile,
  TOOL_NAME.addDependency,
]);

/** Offered after a readonly re-steer — model cannot pick `read` again. */
export const WRITE_FORCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.create,
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
]);

/** Restrict an offered tool list to write-force names (post-readonly-resteer). */
export function filterWriteForceTools<
  T extends { readonly function: { readonly name: string } },
>(tools: readonly T[]): T[] {
  return tools.filter((t) => WRITE_FORCE_TOOL_NAMES.has(t.function.name));
}

/** True when the model issued a mutating tool this turn (even if args rejected). */
export function isAttemptedWriteTool(name: string): boolean {
  return WRITE_ATTEMPT_TOOLS.has(name);
}

export function toolCallsAttemptWrite(
  calls: readonly { readonly name: string }[]
): boolean {
  return calls.some((c) => isAttemptedWriteTool(c.name));
}

/**
 * Next readonly streak after one tool turn.
 * Survey-hold was removed — it delayed parks and made soft re-steers useless.
 */
export function nextReadonlyStreak(opts: {
  readonly previous: number;
  readonly progressed: boolean;
  readonly attemptedWrite: boolean;
}): number {
  if (opts.progressed || opts.attemptedWrite) {
    return 0;
  }

  return opts.previous + 1;
}

/** Keep streak hot after a soft re-steer so the next read burns a recovery. */
export function streakAfterReadonlyResteer(limit: number): number {
  return Math.max(1, limit - 1);
}
