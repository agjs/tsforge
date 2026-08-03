import { isRecord } from "../lib/guards";
import { FAILURE_CLASS, type FailureClass } from "./failure-class";
import type { IRunRecord } from "./eval.types";

/** A cost figure worth keeping: finite and positive. A saved `0` (or NaN, from a
 *  hand-edited file) must be treated as ABSENT exactly as buildRunRecord treats it,
 *  or it re-enters the averaging denominator and drags the reported cost down —
 *  the "cheaper when zeroed" bias the omit rules exist to prevent. */
function costOrAbsent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** `{ [key]: value }` when the figure is real, `{}` when it is absent — so the
 *  narrowed number, not the raw unknown, reaches the record. */
function spreadCost(
  key: "tokensOut" | "tokensIn" | "costPerAcceptedChange",
  value: unknown
): Partial<
  Pick<IRunRecord, "tokensOut" | "tokensIn" | "costPerAcceptedChange">
> {
  const kept = costOrAbsent(value);

  return kept === undefined ? {} : { [key]: kept };
}

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
        ...spreadCost("tokensOut", r.tokensOut),
        ...spreadCost("tokensIn", r.tokensIn),
        ...spreadCost("costPerAcceptedChange", r.costPerAcceptedChange),
        ...(isFailureClass(r.failureClass)
          ? { failureClass: r.failureClass }
          : {}),
      });
    }
  }

  return out;
}
