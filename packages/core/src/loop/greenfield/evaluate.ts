import type { IRenderResult } from "../../browser";
import type { IFeature, IFeatureVerdict } from "./greenfield.types";

/** Result of the deterministic gate for one feature. */
export interface IGateOutcome {
  passed: boolean;
  /** Gate output (first line is surfaced as the verdict note on failure). */
  output: string;
}

/** Result of the LLM quality judge for one feature. */
export interface IJudgeOutcome {
  ok: boolean;
  notes: string;
}

/**
 * The three evaluator layers, injected so `evaluateFeature` is pure and testable
 * and the real wiring (validate / renderCheck / judge) lives at the call site.
 * Order is deliberate: cheapest + most authoritative first.
 */
export interface IEvaluateDeps {
  /** Deterministic gate (tsc/eslint/tests) — the authority for "done". */
  gate(feature: IFeature): Promise<IGateOutcome>;
  /** Browser oracle (renderCheck) — proves the built UI actually runs. */
  browser(feature: IFeature): Promise<IRenderResult>;
  /** LLM rubric — judges quality the gate can't see (reject-by-default). */
  judge(feature: IFeature): Promise<IJudgeOutcome>;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

/**
 * Evaluate one feature through the layered stack and short-circuit on the first
 * failure: deterministic gate → browser oracle → LLM judge. The gate stays the
 * authority — a feature is never "passed" on the judge's say-so alone, and the
 * browser layer is skip-tolerant (no playwright ⇒ it doesn't block). Mirrors the
 * workshop's "hard checks before soft checks" and design-rule #2 (the judge sees
 * the built artifact, never the generator's trace).
 */
export async function evaluateFeature(
  feature: IFeature,
  deps: IEvaluateDeps
): Promise<IFeatureVerdict> {
  const gate = await deps.gate(feature);

  if (!gate.passed) {
    return { passed: false, stage: "gate", notes: firstLine(gate.output) };
  }

  const browser = await deps.browser(feature);

  // A skipped render-check (playwright absent) must not block — it's an
  // enhancement, exactly as the gate's own web ladder treats it.
  if (!browser.ok && browser.skipped !== true) {
    return {
      passed: false,
      stage: "browser",
      notes: browser.errors.join("; "),
    };
  }

  const judged = await deps.judge(feature);

  if (!judged.ok) {
    return { passed: false, stage: "judge", notes: judged.notes };
  }

  return { passed: true, notes: "gate + browser + judge all green" };
}
