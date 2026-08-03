import { isRecord } from "../lib/guards";
import { FAILURE_CLASS, type FailureClass } from "./failure-class";
import type { IRunRecord } from "./eval.types";

/** True for a value that is one of the known failure classes, so a hand-edited or
 *  older sweep JSON cannot smuggle an arbitrary string through. */
function isFailureClass(value: unknown): value is FailureClass {
  if (typeof value !== "string") {
    return false;
  }

  // Widened to string[] so the lookup needs no type assertion (house rule).
  const known: readonly string[] = Object.values(FAILURE_CLASS);

  return known.includes(value);
}

/**
 * Rehydrate the run records from a saved sweep JSON.
 *
 * Restores EVERY metric a record can carry. Reading back only a subset silently
 * blanked those columns on a re-rendered report even though the data was on disk —
 * it had been dropping `loc` and `failureClass`, and would have dropped the cost
 * fields too. A metric that survives the run but not the reload is not measured.
 */
export function parseSweepRecords(value: unknown): IRunRecord[] {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return [];
  }

  const out: IRunRecord[] = [];

  for (const r of value.records) {
    if (
      isRecord(r) &&
      typeof r.label === "string" &&
      typeof r.passed === "boolean" &&
      typeof r.cycles === "number" &&
      typeof r.ms === "number"
    ) {
      out.push({
        label: r.label,
        passed: r.passed,
        cycles: r.cycles,
        ms: r.ms,
        ...(typeof r.quality === "number" ? { quality: r.quality } : {}),
        ...(typeof r.loc === "number" ? { loc: r.loc } : {}),
        ...(typeof r.tokensOut === "number" ? { tokensOut: r.tokensOut } : {}),
        ...(typeof r.costPerAcceptedChange === "number"
          ? { costPerAcceptedChange: r.costPerAcceptedChange }
          : {}),
        ...(isFailureClass(r.failureClass)
          ? { failureClass: r.failureClass }
          : {}),
      });
    }
  }

  return out;
}
