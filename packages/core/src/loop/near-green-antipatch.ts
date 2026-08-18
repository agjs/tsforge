/**
 * Near-green anti-patch lead-in: when the same error key keeps surviving under a
 * near-green count, "smallest change" lockdown rewards micro-patches. Prefer
 * rewriting the failing unit / inverting the approach.
 */
import type { IErrorItem } from "../validate/validate.types";

/** Near-green band — match the lockdown threshold used by injectFeedback. */
export const ANTI_PATCH_NEAR_GREEN_MAX = 3;

/**
 * How many consecutive gate cycles the same error key must survive before we
 * treat micro-patching as the problem. Below samePersist (5) so the nudge
 * arrives before the full stuck ladder, but high enough to ignore one-off reds.
 */
export const ANTI_PATCH_MIN_AGE = 3;

// The lead string must stay listed in HARNESS_USER_PREFIXES (harness-inject.ts)
// or transcript classification misses this inject.
export const ANTI_PATCH_NEAR_GREEN_STEER =
  "⚠ PATCH-UNTIL-GREEN — the same error keeps surviving under a near-green count. " +
  "Your approach is wrong, not just one character off. REWRITE the failing unit " +
  "(or invert the strategy) so the error cannot recur; do NOT keep micro-editing " +
  "the same expression, adding casts, or renaming around it. Touch only what that " +
  "rewrite requires.";

/** True when ≥1 current error has persisted long enough under a near-green set. */
export function looksLikePatchUntilGreen(
  errorAge: ReadonlyMap<string, number>,
  gateErrors: readonly IErrorItem[],
  nearGreenMax: number = ANTI_PATCH_NEAR_GREEN_MAX,
  minAge: number = ANTI_PATCH_MIN_AGE
): boolean {
  if (gateErrors.length === 0 || gateErrors.length > nearGreenMax) {
    return false;
  }

  for (const e of gateErrors) {
    if ((errorAge.get(e.key) ?? 0) >= minAge) {
      return true;
    }
  }

  return false;
}

/** Lead-in for injectFeedback, or "" when the pattern does not match. */
export function antiPatchNearGreenLead(
  errorAge: ReadonlyMap<string, number>,
  gateErrors: readonly IErrorItem[]
): string {
  if (!looksLikePatchUntilGreen(errorAge, gateErrors)) {
    return "";
  }

  return `${ANTI_PATCH_NEAR_GREEN_STEER}\n\n`;
}
