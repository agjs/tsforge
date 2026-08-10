/**
 * The STEERING LADDER. When the model stalls on the same error(s) — the gate
 * isn't converging — the loop used to give up and kill the run. Instead it now
 * escalates a STEER.
 *
 * Crucially, each rung escalates INTELLIGENCE, not more static rules. The gate has
 * already told the model WHAT is wrong (the exact compiler/lint error) — repeating
 * that louder won't unstick it. So the rungs ask the model to work DIFFERENTLY:
 *   L1  STEP BACK — diagnose your own loop and pick a different approach.
 *   L2  INVESTIGATE — use tools: read the imports, grep the codebase for a passing
 *       example, web_search an unfamiliar error. Stop guessing.
 *   L3  CHANGE STRATEGY — invert the failing approach, narrow to one error.
 *   (above the ladder) EXPERT — hand off to a stronger model as the last resort.
 * The harness supplies the nudge; the MODEL supplies the thinking. Rule-specific
 * "playbooks" survive only as an optional reference at L2 for a few known walls —
 * they are a convenience, not the mechanism. Pure/string-building; unit-tested.
 */

/** The essential HEAD of a conversation — the system prompt + the ORIGINAL task
 *  request — used to RESET a context-poisoned run at the top steer rung: drop the
 *  flailing middle (the dead-end attempts the model keeps re-reading and repeating),
 *  keep only these, then the caller appends a fresh directive. Preserves order and
 *  is a no-op-safe pure function (missing system/user → just omitted). */
export function essentialMessages<T extends { readonly role: string }>(
  messages: readonly T[]
): T[] {
  const head: T[] = [];
  const system = messages.find((m) => m.role === "system");

  if (system !== undefined) {
    head.push(system);
  }

  const firstUser = messages.find((m) => m.role === "user");

  if (firstUser !== undefined) {
    head.push(firstUser);
  }

  return head;
}

/** A gate error, narrowed to what a steer needs (rule id, file, message). */
export interface ISteerError {
  readonly rule?: string;
  readonly file?: string;
  readonly message: string;
}

/** Steer escalations before a run parks. Level 1..MAX are steers; above MAX the
 *  loop hands off to an expert model (then parks) — see the loop's stuck check. */
export const STEER_LADDER_MAX = 3;

/** Rule → a worked "here's how to actually satisfy me" recipe, for the handful of
 *  strict rules the model repeatedly can't get past on a from-scratch build. Keyed
 *  by the rule's BARE name (the segment after any `plugin/` prefix). */
const PLAYBOOKS: Record<string, string> = {
  "no-restricted-syntax":
    "`as` cast rejected. Narrow with a TYPE GUARD, never a cast. Keep the allowed " +
    "values in a const map (`as const` IS allowed) and guard with `in`:\n" +
    "    const STATUS = { open: 1, closed: 1 } as const;\n" +
    "    type Status = keyof typeof STATUS;\n" +
    "    function isStatus(v: string): v is Status { return v in STATUS; }\n" +
    "then `if (isStatus(v)) { /* v is Status here */ }`. Never write `x as T`.",
  "no-jsx-computation":
    "Computation inside JSX rejected. Move it OUT: a pure transform → a function in " +
    "`src/lib/<name>.ts` (import and call it); derived state → a `useMemo` in your " +
    "`<feature>.hooks.ts`. The JSX must only READ an already-computed value.",
  "component-file-purity":
    "A component file may hold ONLY imports + the component. Move the flagged " +
    "declaration out and import it back: types → `<feature>.types.ts`, constants → " +
    "`<feature>.constants.ts` (`as const`), pure helpers → `src/lib/`.",
  "no-derived-state-in-effect":
    "Effect + setState is for I/O (fetch, subscribe), not for deriving values. " +
    "If the next state is a pure function of props/state → compute in render or " +
    "`useMemo`. If you need server/async data → keep the effect, set state from " +
    "the async result, and do not also sync props→state in another effect.",
  "no-self-import":
    "This file imports/re-exports from itself. If it's a barrel `index.ts` next to " +
    "an `index.tsx`, DELETE the barrel — the `.tsx` is already the module entry " +
    "(import the folder path). Otherwise define the binding directly here.",
  "max-hooks-per-file":
    "Too many hooks in one file. Split into focused modules — e.g. `<x>.queries.ts` " +
    "(reads) + `<x>.mutations.ts` (writes) — each under the limit; update imports.",
  "one-component-per-file":
    "Two components in one file. Move the second into its own file and import it.",
  "unused-files":
    "knip flags a file no entry reaches. You CANNOT silence it. If it's a co-located " +
    "API test under `src/`, DELETE it and keep the mirrored `tests/` copy (this stack's " +
    "knip test entries are the mirrored tests dir, not co-located src tests). For a " +
    "production file, import it from an entry (an `index.ts` barrel) or delete it.",
};

/** The bare rule name — the segment after the last `/` (so `tsforge/no-jsx-computation`
 *  and `no-jsx-computation` both resolve to the same playbook). */
function bareRule(rule: string): string {
  const parts = rule.split("/");

  return parts[parts.length - 1] ?? rule;
}

/** The playbook for a rule id, or null when none is registered. */
export function playbookFor(rule: string | undefined): string | null {
  if (rule === undefined) {
    return null;
  }

  return PLAYBOOKS[bareRule(rule)] ?? null;
}

/** Normalize text for comparison: trim, lowercase, remove most punctuation/whitespace. */
function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

/** Check if a diagnosis is trivial (too short, or just restates existing errors).
 *  R1 Phase A's diagnosis-only cycle should skip Phase B if the diagnosis is
 *  trivial — the model didn't actually reflect, just regurgitated the errors. */
export function isTrivialDiagnosis(
  content: string,
  errors: readonly ISteerError[]
): boolean {
  const trimmed = content.trim();

  // Very short diagnosis is trivial (< 80 chars).
  if (trimmed.length < 80) {
    return true;
  }

  // If the diagnosis is just a superset of the error messages (restates them without
  // new insight), it's trivial. Normalize both for comparison.
  const diagNorm = normalizeText(trimmed);
  const errorMessages = errors.map((e) => normalizeText(e.message)).join(" ");

  // Diagnosis is a superset of error messages if all normalized error text is
  // contained in the normalized diagnosis.
  if (errorMessages.length > 0 && diagNorm.includes(errorMessages)) {
    return true;
  }

  return false;
}

/** The distinct playbooks for the rules present in `errors`, formatted as a list.
 *  Empty string when none of the current errors has a registered playbook. */
function playbooksFor(errors: readonly ISteerError[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const e of errors) {
    const bare = e.rule === undefined ? "" : bareRule(e.rule);
    const play = playbookFor(e.rule);

    if (play !== null && !seen.has(bare)) {
      seen.add(bare);
      blocks.push(`• ${bare}: ${play}`);
    }
  }

  return blocks.join("\n");
}

/**
 * Build the steer message for an escalation `level` (1..MAX). Each rung escalates
 * INTELLIGENCE (see the module comment):
 *  1 — STEP BACK: diagnose your own loop, pick a different approach.
 *  2 — INVESTIGATE with tools (read imports, grep for a passing example, web_search).
 *  3 — CHANGE STRATEGY: invert the failing approach, one error / one file.
 * `reason` is the convergence-guard diagnosis. `webEnabled` gates the `web_search`
 * suggestion — never tell the model to use a tool the build doesn't have.
 * `diagnosisOnly` (R1 Phase A): if true, ask ONLY for diagnosis, not action
 * (the diagnosis becomes the next steer's input).
 * `progress`: prior vs current gate error counts — when the count dropped, soften
 * the "NOT converging" framing so a mid-fix multi-step approach is not abandoned. */
export function buildSteerMessage(
  level: number,
  errors: readonly ISteerError[],
  reason: string,
  webEnabled = false,
  diagnosisOnly = false,
  progress?: { readonly current: number; readonly prior: number }
): string {
  const improved =
    progress !== undefined &&
    progress.prior >= 0 &&
    progress.current < progress.prior;
  const header = improved
    ? `⚠ STEER (escalation ${String(level)}/${String(STEER_LADDER_MAX)}) — errors improved (${String(progress.prior)}→${String(progress.current)}) but the block remains: ${reason}.`
    : `⚠ STEER (escalation ${String(level)}/${String(STEER_LADDER_MAX)}) — you are NOT converging: ${reason}.`;

  // The rungs escalate INTELLIGENCE, not more static rules. The gate already told
  // the model WHAT is wrong (the compiler/lint error); repeating that won't unstick
  // it. Each rung asks the model to work DIFFERENTLY — reflect, then investigate
  // with tools, then change strategy — and only the rung ABOVE this ladder brings in
  // the expert model. The harness supplies the nudge; the model supplies the thinking.
  if (level <= 1) {
    // STEP BACK — make the model diagnose its OWN loop instead of guessing again.
    if (diagnosisOnly) {
      // Phase A: diagnosis-only, tool-less. No action yet, just reflection.
      return (
        `${header}\nSTEP BACK and DIAGNOSE before you touch anything. In 2–3 sentences answer: ` +
        `(a) what have you been repeatedly trying, (b) WHY does it keep failing, ` +
        `(c) what fundamentally DIFFERENT approach will you take? Your diagnosis will guide the next attempt.`
      );
    }

    // Phase B: act on the diagnosis.
    return (
      `${header}\nSTEP BACK before you touch anything. In 1–2 sentences answer: ` +
      `(a) what have you been repeatedly trying, (b) WHY does it keep failing, ` +
      `(c) what fundamentally DIFFERENT approach will you take now? Then make the ` +
      `change for that — surgical edit or full rewrite, whichever actually fixes it.`
    );
  }

  if (level === 2) {
    // INVESTIGATE with tools — your mental model is wrong; go get the real cause.
    const plays = playbooksFor(errors);
    const ref =
      plays.length > 0
        ? `\n\nKnown-good pattern for what you're failing (use if it fits):\n${plays}`
        : "";

    const web = webEnabled
      ? " if the error is unfamiliar, look it up with `web_search`;"
      : "";

    return (
      `${header}\nStop guessing and INVESTIGATE. Use your tools: read the FULL ` +
      `failing file and the files it imports; search the codebase for how this exact ` +
      `pattern is done in code that ALREADY passes and copy that;${web} then report ` +
      `the real root cause and fix it.${ref}`
    );
  }

  // CHANGE STRATEGY — invert the failing approach and narrow to one thing.
  return (
    `${header}\nChange strategy completely. Pick the SINGLE most-blocking error and ` +
    `fix ONLY it this turn; if your approach to it has already failed twice, do the ` +
    `OPPOSITE of what you've been doing. Touch nothing that already passes. If it ` +
    `still won't yield, a stronger expert model will be brought in to unblock you.`
  );
}
