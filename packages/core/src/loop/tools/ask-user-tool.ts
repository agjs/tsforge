import { str, type IToolContext } from "./tool-context";

/** Prefix marking a tool result the LOOP must intercept rather than feed back to the
 *  model: the model asked the human a bounded question and the turn should PAUSE for
 *  their answer (interactive co-pilot). WS-C2 detects it via {@link isAskUserResult},
 *  surfaces the question, and re-enters the turn with the human's reply. A distinctive
 *  marker (not real prose) so it can't collide with a genuine gate/tool result. */
export const ASK_USER_SENTINEL = "<<<ASK_USER>>>";

/** Returned in an UNATTENDED (non-interactive) run so the model NEVER hangs waiting for
 *  a human that isn't there — it proceeds on its own judgment and logs the assumption.
 *  This is what keeps CI/eval builds from deadlocking on an ask_user call. */
export const ASK_USER_NO_HUMAN =
  "No human is available in this run. Proceed with your best judgment, state the " +
  "assumption you made in your next message, and do NOT call ask_user again for this.";

/** True when a tool result is an ask_user PAUSE sentinel — the loop should surface the
 *  question to the human and await their answer instead of continuing the turn. */
export function isAskUserResult(result: string): boolean {
  return result.startsWith(ASK_USER_SENTINEL);
}

/** The question carried by an ask_user sentinel result (empty string if not one). */
export function askUserQuestion(result: string): string {
  return isAskUserResult(result) ? result.slice(ASK_USER_SENTINEL.length) : "";
}

/**
 * The `ask_user` tool (WS-C1): the co-pilot's raise-hand. The model calls it when it's
 * genuinely blocked on a DECISION only the human can make; the turn pauses, the human
 * answers, and it continues. Behaviour splits on whether a human is present:
 *   - HUMAN PRESENT (`ctx.humanPresent`): returns the {@link ASK_USER_SENTINEL} + question,
 *     which the loop intercepts to surface the question and re-enter with the answer.
 *   - UNATTENDED: returns {@link ASK_USER_NO_HUMAN} immediately so an eval/CI run never
 *     hangs — the model proceeds and logs its assumption.
 * Synchronous: it neither reads the filesystem nor calls out; it only routes control.
 */
export function doAskUser(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const question = str(args, "question").trim();

  if (question.length === 0) {
    return (
      "ask_user needs a non-empty `question` — state the specific decision you are " +
      "blocked on, with the options you're weighing."
    );
  }

  if (ctx.humanPresent !== true) {
    return ASK_USER_NO_HUMAN;
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `ask_user: ${question}`,
  });

  return `${ASK_USER_SENTINEL}${question}`;
}
