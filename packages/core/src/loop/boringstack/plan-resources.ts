import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import type { IFeature } from "../greenfield/greenfield.types";
import type { ISlice } from "../planning/plan-types";

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

/** Layer suffixes the planner sometimes bolts onto an entity, splitting one
 *  resource into two. BoringStack's `new:resource` builds ALL layers (table +
 *  routes + service + schemas + types + UI) from a single entity, so a
 *  `<Entity>Service`/`<Entity>Api`/… is never a separate resource. */
const LAYER_SUFFIXES = [
  "Service",
  "Api",
  "Routes",
  "Controller",
  "Model",
  "Repository",
  "Handler",
] as const;

/**
 * Drop a resource whose id is another resource's id + a layer suffix (e.g.
 * `BookmarkService` when `Bookmark` is also present). The planner occasionally
 * over-splits one entity into entity + service/api/routes; since BoringStack
 * builds every layer from ONE `new:resource`, those duplicates are the same
 * feature and would each cost a full generation cycle. Pure — unit-tested.
 */
export function dedupeLayerVariants(features: IFeature[]): IFeature[] {
  const ids = new Set(features.map((f) => f.id));

  return features.filter((f) => {
    for (const suffix of LAYER_SUFFIXES) {
      if (!f.id.endsWith(suffix)) {
        continue;
      }

      const base = f.id.slice(0, -suffix.length);

      if (base.length > 0 && ids.has(base)) {
        return false; // the base entity already covers this layer
      }
    }

    return true;
  });
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

  return dedupeLayerVariants(resources);
}

/**
 * The resource planner role: turn a one-line build goal into a list of domain
 * resources (database entities, API endpoints, services, etc.) that need to be
 * built. Each resource becomes a feature in the checklist.
 */
const RESOURCE_SYSTEM =
  "You are a domain planner for a BoringStack app. Given a one-line build goal, " +
  "identify the distinct domain ENTITIES it stores — the nouns (e.g. Bookmark, " +
  "Invoice, Customer). Each entity becomes exactly ONE resource: BoringStack's " +
  "generator builds its database table, API routes, service, schemas, types, AND " +
  "UI together from that single entity. Do NOT split an entity's layers into " +
  "separate resources — there is no separate 'XService', 'XApi', or 'XRoutes' " +
  "resource; the service and endpoints are part of the entity. List the SMALLEST " +
  "set of distinct entities that covers the goal. Respond with ONLY a JSON object: " +
  '{"resources":[{"id":"<PascalCase entity>","desc":"<one line>"}]}.';

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

/**
 * Convert a list of plan slices into a feature checklist.
 * Each slice's entity becomes a feature with id and description.
 */
export function slicesToFeatures(slices: readonly ISlice[]): IFeature[] {
  return slices.map((slice) => ({
    id: slice.entity.id,
    desc: slice.entity.desc,
    passes: false,
    attempts: 0,
  }));
}
