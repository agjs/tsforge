import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IStep } from "../../browser";
import { isFeatureId } from "./state";
import type { IFeature } from "./greenfield.types";

/** The planner's output: a human-readable spec + a fresh feature checklist. */
export interface IPlan {
  /** Markdown spec (high-level sprints) → `.tsforge/greenfield/spec.md`. */
  spec: string;
  /** The initial checklist (all `passes:false`, `attempts:0`). */
  features: IFeature[];
}

/**
 * The planner role: turn a one-line build goal into a HIGH-LEVEL spec and a flat
 * feature checklist. Deliberately coarse — sprints/features, not file-level steps
 * — so granular technical errors don't cascade across the whole build (design
 * rule #4: the planner stays high-level). The generator and evaluator work one
 * feature at a time against this; the planner is consulted once, up front.
 */
const SYSTEM =
  "You are a software planner. Given a one-line build goal, produce a HIGH-LEVEL " +
  "plan: a short markdown spec (think sprints/milestones, NOT file-level steps) " +
  "and a flat checklist of user-visible features, each independently verifiable. " +
  "Keep features coarse (5–12 total). Respond with ONLY a JSON object: " +
  '{"spec":"<markdown>","features":[{"id":"<kebab-case>","desc":"<one line>"}]}.';

function toFeature(value: unknown): IFeature | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, desc, steps } = value;

  if (typeof id !== "string" || typeof desc !== "string" || !isFeatureId(id)) {
    return null;
  }

  const feature: IFeature = { id, desc, passes: false, attempts: 0 };

  if (Array.isArray(steps)) {
    feature.steps = steps.filter((s): s is IStep => isRecord(s));
  }

  return feature;
}

/** Parse the planner's raw JSON into a plan, or null when it isn't usable (no
 *  valid features). Pure — split out so it can be unit-tested without a provider. */
export function parsePlan(raw: string): IPlan | null {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }

  if (!isRecord(data) || !Array.isArray(data.features)) {
    return null;
  }

  const features = data.features
    .map(toFeature)
    .filter((f): f is IFeature => f !== null);

  if (features.length === 0) {
    return null;
  }

  const spec = typeof data.spec === "string" ? data.spec : "";

  return { spec, features };
}

/** Ask the model to plan a build from a one-line goal. Returns null when the
 *  model's response can't be parsed into a usable checklist (caller decides how
 *  to surface that — there's nothing to build without features). */
export async function planFeatures(
  provider: IProvider,
  goal: string
): Promise<IPlan | null> {
  const res = await provider.complete(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Build goal: ${goal}` },
    ],
    { temperature: 0 }
  );

  return parsePlan(res.content);
}
