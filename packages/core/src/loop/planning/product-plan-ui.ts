import { isRecord } from "../../lib/guards";
import type {
  IPlanDraft,
  IChecklistItemDraft,
} from "../worklist/checklist.types";
import type { IProductPlan } from "./plan-types";

function uiSummary(ui: unknown): string {
  if (!isRecord(ui)) {
    return "";
  }

  const bits: string[] = [];

  if (typeof ui.kind === "string" && ui.kind.length > 0) {
    bits.push(ui.kind);
  }

  if (typeof ui.scene === "string" && ui.scene.length > 0) {
    bits.push(`scene ${ui.scene}`);
  }

  if (typeof ui.feature === "string" && ui.feature.length > 0) {
    bits.push(`feature ${ui.feature}`);
  }

  return bits.join(" · ");
}

/**
 * Turn a stack product plan into the worklist draft the yellow PLAN card paints.
 * Never the raw JSON blob — titles + one-line details only.
 */
export function productPlanToDraft(plan: IProductPlan): IPlanDraft {
  const items: IChecklistItemDraft[] = [];

  for (const slice of plan.slices) {
    const extra = uiSummary(slice.ui);
    const detail =
      extra.length > 0 ? `${slice.entity.desc} · ${extra}` : slice.entity.desc;

    items.push({
      title: slice.entity.id,
      detail,
      kind: "create",
      verify: slice.verification.acceptanceCheck,
    });
  }

  return { goal: plan.product, items };
}
