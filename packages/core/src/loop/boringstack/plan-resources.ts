import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IFeature } from "../greenfield/greenfield.types";

/**
 * Validator for resource IDs: PascalCase (e.g., Invoice, Customer).
 * Starts with uppercase, followed by alphanumeric characters.
 */
function isResourceId(id: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/u.test(id);
}

/**
 * Parse one resource object into an IFeature, dropping it (→ null) when it
 * isn't shaped like one. No `as` casts — every field is checked.
 */
function toResource(value: unknown): IFeature | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, desc } = value;

  if (typeof id !== "string" || typeof desc !== "string" || !isResourceId(id)) {
    return null;
  }

  return { id, desc, passes: false, attempts: 0 };
}

/**
 * Parse the resource planner's raw JSON into a feature list, or null when it
 * isn't usable (no valid resources). Pure — split out so it can be unit-tested
 * without a provider.
 */
export function parseResources(raw: string): IFeature[] | null {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }

  if (!isRecord(data) || !Array.isArray(data.resources)) {
    return null;
  }

  const resources = data.resources
    .map(toResource)
    .filter((f): f is IFeature => f !== null);

  if (resources.length === 0) {
    return null;
  }

  return resources;
}

/**
 * The resource planner role: turn a one-line build goal into a list of domain
 * resources (database entities, API endpoints, services, etc.) that need to be
 * built. Each resource becomes a feature in the checklist.
 */
const RESOURCE_SYSTEM =
  "You are a domain planner. Given a one-line build goal, identify the key " +
  "domain resources (entities, services, API endpoints) that must exist. " +
  "Respond with ONLY a JSON object: " +
  '{"resources":[{"id":"<PascalCase>","desc":"<one line>"}]}.';

/**
 * Ask the model to plan resources for a one-line goal. Returns an empty array
 * when the model's response can't be parsed into a usable checklist. Retries
 * once with higher temperature on parse failure (temp 0 → 0.4).
 */
export async function planResources(
  provider: IProvider,
  goal: string
): Promise<IFeature[]> {
  // First attempt: temperature 0 (deterministic)
  const res1 = await provider.complete(
    [
      { role: "system", content: RESOURCE_SYSTEM },
      { role: "user", content: `Build goal: ${goal}` },
    ],
    { temperature: 0 }
  );

  const parsed1 = parseResources(res1.content);

  if (parsed1 !== null) {
    return parsed1;
  }

  // Retry: temperature 0.4 (more creative/forgiving)
  const res2 = await provider.complete(
    [
      { role: "system", content: RESOURCE_SYSTEM },
      { role: "user", content: `Build goal: ${goal}` },
    ],
    { temperature: 0.4 }
  );

  const parsed2 = parseResources(res2.content);

  return parsed2 ?? [];
}
