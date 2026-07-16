import type { ILoopEvent } from "../loop.types";

import type { ICandidateLesson } from "./memory.types";

/** Cap edits attributed to a single fix window — keeps a noisy burst of edits
 *  from cross-producing a flood of weak candidates (the hits gate filters the
 *  rest anyway). */
const MAX_EDITS_PER_WINDOW = 3;

/** Gate verdicts that are NOT line-level code patterns. A mined lesson pairs a
 *  rule with a before→after edit snippet, which only generalizes when the rule
 *  names a *code construct* (a TS error code, an eslint rule). These verdicts are
 *  structural or behavioral — a route not wired (`reachability`), a quality
 *  critique (`judge`), a failing assertion (`bun-test`), an unreachable file
 *  (`knip/unused-files`), or an unparseable source (`syntax`) — so the edit that
 *  clears one is arbitrary; attaching it to the verdict just noises up the ledger.
 *
 *  This is a DENYLIST, keep-by-default: every real diagnostic id is learnable,
 *  including bare eslint core rules with no `/` or `-` (`eqeqeq`, `curly`, `semi`,
 *  `quotes`, `radix`), which this repo's gate enables as errors. A pattern
 *  allowlist that required a `/` or `-` would silently drop those — the exact
 *  no-silent-truncation trap this replaces. */
const NON_PATTERN_VERDICTS = new Set<string>([
  "reachability",
  "judge",
  "bun-test",
  "syntax",
  "knip/unused-files",
  // The unclassified-gate fallback. Today opaqueGateError carries no `.rule`, so
  // turn.ts drops it before mining — but it is precisely the kind of opaque
  // verdict this set names, so denylist it too: cheap insurance if the gate ever
  // starts surfacing the fallback as a rule id.
  "gate-nonzero",
]);

function isLearnableRule(rule: string): boolean {
  return !NON_PATTERN_VERDICTS.has(rule);
}

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
    // The pre-run RED gate is a `red` event (not `validated`), so seed the
    // baseline failing set from it — otherwise a one-turn red→green fix, whose
    // only `validated` event is the GREEN one, would mine nothing.
    if (event.kind === "red") {
      prevFailing = new Set(event.rules ?? []);

      continue;
    }

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
      const fixed = [...prevFailing].filter(
        (rule) => !failing.has(rule) && isLearnableRule(rule)
      );

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
