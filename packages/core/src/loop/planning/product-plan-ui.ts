import type {
  IPlanDraft,
  IChecklistItemDraft,
} from "../worklist/checklist.types";
import type { IProductPlan } from "./plan-types";

const ENTITY_ID = /"entity"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z][A-Za-z0-9]*)"/gu;

/** Slice entity ids parsed out of a streaming planner JSON buffer. */
export function plannerSliceIds(raw: string): readonly string[] {
  const ids: string[] = [];

  for (const match of raw.matchAll(ENTITY_ID)) {
    const id = match[1];

    if (id !== undefined && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * Turn a stack product plan into the worklist draft the yellow PLAN card paints.
 * Titles + the entity description — never raw JSON, never ui-kind noise.
 */
export function productPlanToDraft(plan: IProductPlan): IPlanDraft {
  const items: IChecklistItemDraft[] = [];

  for (const slice of plan.slices) {
    items.push({
      title: slice.entity.id,
      detail: slice.entity.desc,
      kind: "create",
      verify: slice.verification.acceptanceCheck,
    });
  }

  return { goal: plan.product, items };
}
