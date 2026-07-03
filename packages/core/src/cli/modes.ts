/**
 * Interactive session modes — the set cycled by Shift+Tab and shown in the status
 * bar. This is the extension point: add a mode by adding one entry below. The
 * ARRAY ORDER is the Shift+Tab cycle order.
 *
 * A mode only needs to say (a) its stable id, (b) a short status-bar label, and
 * (c) how to realize itself on the session. Keeping "how" as a callback means a
 * new mode can drive whatever session API it needs without this module growing a
 * switch — e.g. a future "auto-accept" would call a policy setter here.
 */

/** The slice of Session a mode needs to realize itself. Kept minimal so modes
 *  stay decoupled from the full Session surface (and trivially fakeable in tests). */
export interface IModeTarget {
  setPlanMode(on: boolean): void;
}

export interface ISessionMode {
  /** Stable id (referenced by `/plan`, persisted as planMode today). */
  readonly id: string;
  /** Short label shown in the status bar. */
  readonly label: string;
  /** Realize this mode on the session. */
  apply(session: IModeTarget): void;
}

/** Plan-first: read-only, propose a plan, approve to build. */
const PLAN: ISessionMode = {
  id: "plan",
  label: "plan",
  apply: (session) => {
    session.setPlanMode(true);
  },
};

/** Autonomous: the configured base posture (edits/run without an approval gate). */
const NORMAL: ISessionMode = {
  id: "normal",
  label: "normal",
  apply: (session) => {
    session.setPlanMode(false);
  },
};

/** The Shift+Tab cycle, in order. Extend by adding entries. */
export const SESSION_MODES: readonly ISessionMode[] = [NORMAL, PLAN];

/** The mode for an id, or NORMAL when the id is unknown (safe default). */
export function modeById(id: string): ISessionMode {
  return SESSION_MODES.find((m) => m.id === id) ?? NORMAL;
}

/** The next mode in the cycle after `currentId` (wraps; unknown id → first). */
export function nextMode(currentId: string): ISessionMode {
  const i = SESSION_MODES.findIndex((m) => m.id === currentId);

  return SESSION_MODES[(i + 1) % SESSION_MODES.length] ?? NORMAL;
}
