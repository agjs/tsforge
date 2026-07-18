import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";

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

/** What the feature judge is shown — the built artifact only, never the
 *  generator's trace (design-rule #2, mirrors eval's IJudgeInput). */
export interface IFeatureJudgeInput {
  /** The feature being judged. */
  feature: string;
  /** The relevant built code. */
  code: string;
  /** Entities/features that belong to OTHER slices in the same build and are NOT
   *  this feature's responsibility. Names only. When set, the judge is told not to
   *  reject THIS feature for lacking associations to a sibling that a later slice
   *  owns — the bug that parked a live inventory build: the Supplier judge demanded
   *  a link to Product (a not-yet-built slice), so the model created Product early
   *  and the Product slice's scaffolder then collided on the duplicate. */
  siblingEntities?: string[];
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

/** Build the sibling-scope clause: tells the judge which entities belong to OTHER
 *  slices so it does not reject THIS feature for lacking a cross-slice association.
 *  Empty when there are no siblings, so a single-entity build judges exactly as
 *  before. Pure — unit-testable. */
export function siblingScopeClause(siblings: readonly string[]): string {
  const named = siblings.map((s) => s.trim()).filter((s) => s.length > 0);

  if (named.length === 0) {
    return "";
  }

  return (
    `\n\nThis feature is ONE slice of a larger app. These other entities have their ` +
    `OWN separate slices, built elsewhere: ${named.join(", ")}. Judge THIS feature's ` +
    `own responsibilities in full — its own fields, validation, endpoints, and UI. But ` +
    `do NOT reject it for not BUILDING those other entities here: their tables, ` +
    `resources, CRUD, and pages belong to their slices, and creating them here collides ` +
    `with the slice that owns them. A relationship BETWEEN entities is owned by exactly ` +
    `one side (the slice that holds the foreign key); judge it only in that owning slice, ` +
    `not in the other. If THIS feature's own description requires a field or behavior, ` +
    `still require it.`
  );
}

/** Run the reject-by-default feature judge. */
export async function judgeFeature(
  provider: IProvider,
  input: IFeatureJudgeInput
): Promise<IJudgeOutcome> {
  const scope = siblingScopeClause(input.siblingEntities ?? []);
  const res = await provider.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Feature: ${input.feature}${scope}\n\nCode:\n${input.code}`,
      },
    ],
    { temperature: 0 }
  );

  return parseFeatureVerdict(res.content);
}
