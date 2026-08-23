import type { IProvider } from "../../inference";
import { extractJson } from "../../lib/json";
import { isProductPlan } from "./plan-store";
import type { IProductPlan, IPlanConstraints, IPlanSchema } from "./plan-types";

/**
 * Parse the planner's raw JSON reply into an IProductPlan, or null on failure. Generic over the
 * UI-intent type: the slice `ui` and any cross-slice rule are validated by the injected schema
 * (`validateUi` / `extraCheck`), so no web-specific plan shape lives in this generic planner.
 * Pure — split out so it can be unit-tested without a provider.
 */
export function parsePlanJson<TUi>(
  raw: string,
  validateUi: (v: unknown) => v is TUi,
  extraCheck?: (plan: IProductPlan<TUi>) => boolean
): IProductPlan<TUi> | null {
  try {
    const json: unknown = JSON.parse(extractJson(raw));

    return isProductPlan(json, validateUi, extraCheck) ? json : null;
  } catch {
    return null;
  }
}

/** Drop slices whose entity id is in `reserved` (compared lowercased). Caller-
 *  supplied so the rule is STACK-SPECIFIC, not baked into the generic planner. May
 *  return a plan with ZERO slices — an all-reserved response is mis-scoped, and the
 *  caller turns an empty result into null (a FINITE planning failure), strictly
 *  better than re-emitting the reserved slices into an infinite build loop. */
export function stripReservedSlices<TUi>(
  plan: IProductPlan<TUi>,
  reserved: ReadonlySet<string>
): IProductPlan<TUi> {
  return {
    ...plan,
    slices: plan.slices.filter(
      (slice) => !reserved.has(slice.entity.id.toLowerCase())
    ),
  };
}

/**
 * Ask the model to propose a structured product plan from a description.
 * Returns null when the model's response can't be parsed into a usable plan.
 * Retries once at higher temperature (0 → 0.7) on parse failure.
 *
 * `constraints` is OPT-IN and stack-specific: with none (the default) the planner
 * is generic — no extra prompt guidance and NO slice stripping, so a plain build
 * keeps a `User` entity if it needs one. A BoringStack build passes its guidance +
 * reserved set; reserved slices are then stripped, and if that leaves NO slices
 * (all-reserved, mis-scoped) the result is null — a finite planning failure, never
 * a plan that re-emits the reserved-slice trap.
 */
export async function proposePlan<TUi>(
  deps: {
    planner: IProvider;
    onToken?: (text: string, channel: "reasoning" | "content" | "tool") => void;
  },
  input: { description: string; mockups?: readonly string[] },
  schema: IPlanSchema<TUi>,
  constraints: IPlanConstraints = {}
): Promise<IProductPlan<TUi> | null> {
  const system =
    constraints.guidance === undefined
      ? schema.system
      : `${schema.system}\n\n${constraints.guidance}`;
  const userMessage =
    input.mockups !== undefined && input.mockups.length > 0
      ? `Product description: ${input.description}\n\nMockup refs: ${input.mockups.join(", ")}`
      : `Product description: ${input.description}`;

  const parse = (raw: string): IProductPlan<TUi> | null =>
    parsePlanJson(raw, schema.validateUi, schema.extraCheck);

  const usable = (
    parsed: IProductPlan<TUi> | null
  ): IProductPlan<TUi> | null => {
    if (parsed === null) {
      return null;
    }

    const { reservedEntities, onStripped } = constraints;

    if (reservedEntities === undefined) {
      return parsed; // stack-agnostic: never strip
    }

    // Compute drops directly from the reserved-set membership (not object identity),
    // so this stays correct even if stripReservedSlices is later rewritten to copy.
    const droppedIds = parsed.slices
      .map((s) => s.entity.id)
      .filter((id) => reservedEntities.has(id.toLowerCase()));

    if (droppedIds.length > 0) {
      onStripped(droppedIds); // REQUIRED by the type — a drop is never silent
    }

    const stripped = stripReservedSlices(parsed, reservedEntities);

    if (stripped.slices.length === 0) {
      return null;
    }

    // Re-apply the schema's cross-slice rule to the STRIPPED plan: stripping can invalidate an
    // invariant that held on the full plan (e.g. removing the slice that satisfied it), so a
    // transformed plan is never returned unchecked.
    if (schema.extraCheck !== undefined && !schema.extraCheck(stripped)) {
      return null;
    }

    return stripped;
  };

  const tokenOpts = deps.onToken === undefined ? {} : { onToken: deps.onToken };

  // First attempt: temperature 0 (deterministic)
  const res1 = await deps.planner.complete(
    [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    { temperature: 0, ...tokenOpts }
  );

  // A first attempt that fails to parse OR strips to zero usable slices both fall
  // through to the higher-temperature retry — a fresh attempt may yield real domain
  // slices. Only when the retry also yields nothing usable is the result null.
  const first = usable(parse(res1.content));

  if (first !== null) {
    return first;
  }

  // Retry: temperature 0.7 (more creative/forgiving)
  const res2 = await deps.planner.complete(
    [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    { temperature: 0.7, ...tokenOpts }
  );

  return usable(parse(res2.content));
}
