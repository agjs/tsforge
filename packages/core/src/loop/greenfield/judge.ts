import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IJudgeOutcome } from "./evaluate";

/** What the feature judge is shown — the built artifact only, never the
 *  generator's trace (design-rule #2, mirrors eval's IJudgeInput). */
export interface IFeatureJudgeInput {
  /** The feature being judged. */
  feature: string;
  /** The relevant built code. */
  code: string;
}

/**
 * A HARSH, reject-by-default judge for a greenfield feature — the soft-quality
 * layer that runs only AFTER the deterministic gate and browser oracle are green.
 * Mirrors review-change's VERIFY_SYSTEM: the default answer is "not done", and a
 * feature passes only if the code clearly and fully implements it. This stops a
 * model from declaring victory on a stub that merely compiles and renders.
 */
const SYSTEM =
  "You are a harsh senior reviewer judging whether ONE feature is fully and " +
  "correctly implemented in the code shown. Be skeptical and default to REJECT: " +
  "pass ONLY if the code clearly and completely implements the feature with no " +
  "stubs, TODOs, or obviously missing cases. If the evidence is partial, " +
  "ambiguous, or absent, reject. You see only the built code, never how it was " +
  'produced. Respond with ONLY JSON: {"pass":true|false,"notes":"<one sentence>"}.';

/** Parse the judge's raw JSON; an unparseable response is a REJECT (fail closed,
 *  consistent with the reject-by-default rubric). Pure — unit-testable. */
export function parseFeatureVerdict(raw: string): IJudgeOutcome {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return { ok: false, notes: "unparseable judge response" };
  }

  if (!isRecord(data)) {
    return { ok: false, notes: "unparseable judge response" };
  }

  return {
    ok: data.pass === true,
    notes: typeof data.notes === "string" ? data.notes : "",
  };
}

/** Run the reject-by-default feature judge. */
export async function judgeFeature(
  provider: IProvider,
  input: IFeatureJudgeInput
): Promise<IJudgeOutcome> {
  const res = await provider.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Feature: ${input.feature}\n\nCode:\n${input.code}`,
      },
    ],
    { temperature: 0 }
  );

  return parseFeatureVerdict(res.content);
}
