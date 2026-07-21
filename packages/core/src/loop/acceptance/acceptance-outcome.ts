import type {
  AcceptStep,
  IAcceptanceResult,
  IAcceptanceOutcome,
} from "./acceptance.types";

/**
 * Summarize acceptance results into an outcome.
 * - ok = true only if all results pass AND (if requiredSteps specified) all required steps are present
 * - on any failure, ok=false and bubble the first failing result's detail
 * - Empty results → ok=false with "nothing ran" message
 * - Missing required step → ok=false with "acceptance incomplete: missing step" message
 * - infraError is NOT set by this function (runner's responsibility)
 */
export function summarize(
  results: IAcceptanceResult[],
  requiredSteps?: AcceptStep[]
): IAcceptanceOutcome {
  if (results.length === 0) {
    return {
      ok: false,
      results: [],
      detail: "no acceptance checks ran",
    };
  }

  const firstFailure = results.find((r) => !r.ok);

  if (firstFailure !== undefined) {
    return {
      ok: false,
      results,
      detail: firstFailure.detail,
    };
  }

  // All results passed; check if required steps are present
  if (requiredSteps !== undefined && requiredSteps.length > 0) {
    const presentSteps = new Set(results.map((r) => r.step));
    const missingSteps = requiredSteps.filter((s) => !presentSteps.has(s));

    if (missingSteps.length > 0) {
      const missingStep = missingSteps[0] ?? "unknown";

      return {
        ok: false,
        results,
        detail: `acceptance incomplete: missing step '${missingStep}'`,
      };
    }
  }

  return {
    ok: true,
    results,
    detail: undefined,
  };
}
