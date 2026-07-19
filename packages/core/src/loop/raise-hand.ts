import type { IHandoff } from "./loop.types";
import type { ISendResult } from "./session";

/** WS-C3 — stuck → ASK instead of PARK.
 *
 *  When the escalation ladder exhausts (or a read-only / timeout spin gives up) and no
 *  expert rescue applies, an UNATTENDED build parks with a structured handoff. But when a
 *  human co-pilot is present, parking wastes them: the build should RAISE A HAND — pose
 *  the block to the human and pause — instead of dying on a wall a 30-second nudge clears.
 *
 *  These pure helpers own the park-vs-raise-hand DECISION so it can be unit-locked away
 *  from the Session's side effect (emitting the `ask_user` event that renders the
 *  question). The Session wraps `parkOrRaiseHand` and emits that event when a question
 *  comes back, then returns the terminal directly. NOTE: unlike the ask_user TOOL path,
 *  a raise-hand does NOT set `state.pendingAskUser` — that flag is the tool-call→
 *  runToolTurn handoff; a gate terminal returns the `responded`+`awaitingUser` result
 *  itself, so setting it would leak into the next send. Headless / eval (humanPresent
 *  false) get today's park VERBATIM — same `{status:"stuck"}` shape, same handoff — so no
 *  unattended path changes. */

/** How many of the persisting errors to show the human in the raise-hand prompt. Enough
 *  to decide, not a wall of text. */
const RAISE_HAND_ERRORS_SHOWN = 4;

/** Build the question a stuck build poses to its co-pilot, derived from the handoff the
 *  escalation ladder already assembled (the block identity, what it needs, and the errors
 *  that would not clear). This is the same material a headless park reports — here it
 *  becomes a direct ask instead of a dead end. */
export function raiseHandQuestion(handoff: IHandoff): string {
  const shown = handoff.errors.slice(0, RAISE_HAND_ERRORS_SHOWN);
  const more = handoff.errors.length - shown.length;
  const errorLines = shown.map((e) => `  • ${e}`).join("\n");
  const overflow = more > 0 ? `\n  …and ${String(more)} more` : "";
  const ask = handoff.ask.trim();
  // handoff.ask can be empty on a synthetic (spin/timeout) block — fall back to a plain
  // ask so the human is never handed a blank request.
  const request =
    ask.length > 0
      ? ask
      : "I've exhausted my automatic fixes here and can't make progress.";

  return (
    `I'm stuck and could use your steer. ${request}\n\n` +
    `The errors that won't clear:\n${errorLines}${overflow}\n\n` +
    `How should I proceed?`
  );
}

/** Decide, at a stuck terminal, between parking (unattended) and raising a hand
 *  (co-pilot present). Pure: returns the terminal `ISendResult` plus, when a hand is
 *  raised, the `question` the Session emits as an `ask_user` event to render it. A raise
 *  hand is terminal-for-NOW (`status:"responded"` + `awaitingUser`) exactly like the
 *  ask_user tool pause — the human's next send resumes the build; it does NOT advance the
 *  steer ladder or reset the block, since no new attempt was made. */
export function parkOrRaiseHand(
  handoff: IHandoff,
  humanPresent: boolean,
  turn: number
): { result: ISendResult; question?: string } {
  if (!humanPresent) {
    // Unattended: today's park, byte-identical (stuck + the handoff).
    return { result: { status: "stuck", turns: turn, handoff } };
  }

  const question = raiseHandQuestion(handoff);

  return {
    result: { status: "responded", turns: turn, awaitingUser: question },
    question,
  };
}
