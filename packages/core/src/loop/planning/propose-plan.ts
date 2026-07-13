import type { IProvider } from "../../inference";
import { extractJson } from "../../lib/json";
import { isProductPlan } from "./plan-store";
import type { IProductPlan } from "./plan-types";

/**
 * System prompt for the product architect role: turn a product description
 * + optional mockups into a structured product plan (domain model + slices + UI + verification).
 */
const PLANNER_SYSTEM =
  "You are a product architect. From the product description and any mockups, " +
  "propose a domain model with feature slices, UI intent, and verification contracts. " +
  "For each slice, define the entity (PascalCase id, description, fields with types, relationships, rules), " +
  "the UI intent (screens, primary action, what shows, navigation label), " +
  "and the verification contract (what must remain true, what must not happen, acceptance check command). " +
  "Respond with ONLY the JSON plan in this shape: " +
  '{"product":"<one-paragraph purpose>","slices":[{"entity":{...},"ui":{...},"verification":{...}}]}';

/**
 * Parse the planner's raw JSON reply into an IProductPlan, or null on failure.
 * Pure — split out so it can be unit-tested without a provider.
 */
export function parsePlanJson(raw: string): IProductPlan | null {
  try {
    const json: unknown = JSON.parse(extractJson(raw));

    return isProductPlan(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Ask the model to propose a structured product plan from a description.
 * Returns null when the model's response can't be parsed into a usable plan.
 * Retries once at higher temperature (0 → 0.7) on parse failure.
 */
export async function proposePlan(
  deps: { planner: IProvider },
  input: { description: string; mockups?: readonly string[] }
): Promise<IProductPlan | null> {
  const userMessage =
    input.mockups !== undefined && input.mockups.length > 0
      ? `Product description: ${input.description}\n\nMockup refs: ${input.mockups.join(", ")}`
      : `Product description: ${input.description}`;

  // First attempt: temperature 0 (deterministic)
  const res1 = await deps.planner.complete(
    [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: userMessage },
    ],
    { temperature: 0 }
  );

  const parsed1 = parsePlanJson(res1.content);

  if (parsed1 !== null) {
    return parsed1;
  }

  // Retry: temperature 0.7 (more creative/forgiving)
  const res2 = await deps.planner.complete(
    [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: userMessage },
    ],
    { temperature: 0.7 }
  );

  const parsed2 = parsePlanJson(res2.content);

  return parsed2 ?? null;
}
