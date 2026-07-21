import type { IAcceptanceResult, IAcceptanceOutcome } from "./acceptance.types";

/**
 * Summarize acceptance results into an outcome.
 * - ok = true only if all results pass
 * - on any failure, ok=false and bubble the first failing result's detail
 * - Empty results → ok=false with "nothing ran" message
 * - infraError is NOT set by this function (runner's responsibility)
 */
export function summarize(results: IAcceptanceResult[]): IAcceptanceOutcome {
  if (results.length === 0) {
    return {
      ok: false,
      results: [],
      infraError: undefined,
    };
  }

  const firstFailure = results.find((r) => !r.ok);

  if (firstFailure === undefined) {
    return {
      ok: true,
      results,
      infraError: undefined,
    };
  }

  return {
    ok: false,
    results,
    infraError: undefined,
  };
}
