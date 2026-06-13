import type { ILoopEvent } from "../loop.types";

import type { ICandidateLesson } from "./memory.types";

/** Cap edits attributed to a single fix window — keeps a noisy burst of edits
 *  from cross-producing a flood of weak candidates (the hits gate filters the
 *  rest anyway). */
const MAX_EDITS_PER_WINDOW = 3;

interface IEditWindow {
  file: string;
  before: string;
  after: string;
}

/**
 * Mine a run's event stream for failure→fix lessons: a gate rule/code that was
 * FAILING and then DISAPPEARED after one or more edits. Each such (rule, edit)
 * pair is a candidate — the edit's replaced text (`before`) is the mistake, its
 * replacement (`after`) is the fix.
 *
 * Deterministic, no model call. Only `edit` events teach (they carry the
 * before→after diff); `create` is net-new so there is no mistake-pattern to
 * learn. Attribution is coarse (the validated event lists rule codes, not their
 * files), so one fix window can yield a few candidates; the cross-session hits
 * gate in consolidation is what promotes only the recurring, real ones.
 */
export function mineLessons(events: readonly ILoopEvent[]): ICandidateLesson[] {
  const candidates: ICandidateLesson[] = [];
  let prevFailing: Set<string> | null = null;
  let edits: IEditWindow[] = [];

  for (const event of events) {
    if (
      event.kind === "edit" &&
      event.file !== undefined &&
      event.oldString !== undefined &&
      event.newString !== undefined &&
      event.oldString.trim().length > 0
    ) {
      edits.push({
        file: event.file,
        before: event.oldString,
        after: event.newString,
      });

      continue;
    }

    if (event.kind !== "validated") {
      continue;
    }

    const failing = new Set(event.rules ?? []);

    if (prevFailing !== null && edits.length > 0) {
      const fixed = [...prevFailing].filter((rule) => !failing.has(rule));

      for (const rule of fixed) {
        for (const edit of edits.slice(-MAX_EDITS_PER_WINDOW)) {
          candidates.push({
            rule,
            file: edit.file,
            before: edit.before,
            after: edit.after,
          });
        }
      }
    }

    prevFailing = failing;
    edits = [];
  }

  return candidates;
}
