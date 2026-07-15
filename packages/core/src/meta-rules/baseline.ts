import type { IMetaRuleViolation } from "./meta-rules.types";

/**
 * Counts of the meta-rule violations present on the PRISTINE scaffold (before any
 * model work). The differential loop subtracts this so a feature is graded only on
 * violations IT introduced — pre-existing scaffold debt (e.g. a missing lockfile or
 * a workflow's permissions) in files the model is frozen out of must never block a
 * feature or clutter its feedback.
 *
 * Keyed as a COUNTED multiset over `(file, ruleId, severity, message)`. A coarser key
 * (e.g. `file:ruleId`) would let one pre-existing violation suppress a newly-introduced
 * duplicate of the same rule in the same file — hiding a real regression.
 */
export type MetaBaseline = ReadonlyMap<string, number>;

// NUL delimiter — it cannot appear in a path, rule id, severity, or message. Built
// from the code point so the source carries no literal control char.
const KEY_SEP = String.fromCharCode(0);

function metaKey(v: IMetaRuleViolation): string {
  return [v.file, v.ruleId, v.severity, v.message].join(KEY_SEP);
}

/** Build the multiset of pristine meta violations captured before any model work. */
export function buildMetaBaseline(
  violations: readonly IMetaRuleViolation[]
): MetaBaseline {
  const counts = new Map<string, number>();

  for (const v of violations) {
    const key = metaKey(v);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/**
 * Drop the violations already present on the pristine scaffold. Differential by
 * COUNT: each baselined key suppresses at most that many current violations, so a
 * duplicate the model newly introduced still surfaces. Undefined/empty baseline is a
 * no-op (returns the input unchanged).
 */
export function subtractMetaBaseline(
  violations: readonly IMetaRuleViolation[],
  baseline: MetaBaseline | undefined
): IMetaRuleViolation[] {
  if (baseline === undefined || baseline.size === 0) {
    return [...violations];
  }

  const remaining = new Map(baseline);
  const kept: IMetaRuleViolation[] = [];

  for (const v of violations) {
    const key = metaKey(v);
    const left = remaining.get(key) ?? 0;

    if (left > 0) {
      remaining.set(key, left - 1);
    } else {
      kept.push(v);
    }
  }

  return kept;
}
