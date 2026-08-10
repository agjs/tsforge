/**
 * Soft decomposition advice for present_plan — warnings only, never a reject.
 */
import type { IChecklistItem, IPlanDocument } from "./checklist.types";

/**
 * Titles that are gate chores (harness already validates on task_complete).
 * Anchored so filenames like `notes.test.ts` are not false positives.
 */
const GATE_CHORE_TITLE =
  /^(?:run\s+)?(?:the\s+)?(?:tests?|lint|gate|tsc|typecheck|eslint|prettier)\b|\brun\s+(?:the\s+)?(?:tests?|lint|gate|tsc|typecheck|eslint|prettier)\b/iu;

/**
 * Vertical / shippable outcomes — these are NOT layer chores even if they
 * mention types/hooks in the detail.
 */
const VERTICAL_TITLE =
  /\b(feed|detail|form|scaffold|polish|end[- ]?to[- ]?end|e2e|slice|feature|screen|page)\b/iu;

/**
 * Layer-only checklist titles (types → mocks → api → …). Dogfood: models treated
 * ≤3-files / "split by module" advice as law and planned horizontal layers.
 */
const LAYER_ONLY_TITLE =
  /^(?:(?:add|create|define|wire|build|set\s*up|setup)\s+)?(?:the\s+)?(?:types?(?:\s+definitions?)?|interfaces?|mocks?(?:\s+handlers?)?|msw|seed(?:\s+data)?|data\s+layer|api(?:\s+layer)?|services?|hooks?(?:\s+layer)?|components?(?:\s+layer)?|ui\s+primitives?|pages?(?:\s+layer)?)\b/iu;

function walkItems(
  items: readonly IChecklistItem[],
  visit: (item: IChecklistItem) => void
): void {
  for (const item of items) {
    visit(item);

    if (item.children !== undefined) {
      walkItems(item.children, visit);
    }
  }
}

/** True when a title looks like a horizontal layer pass, not a vertical slice. */
export function isLayerShapedTitle(title: string): boolean {
  if (VERTICAL_TITLE.test(title)) {
    return false;
  }

  return LAYER_ONLY_TITLE.test(title.trim());
}

/**
 * Advisory warnings for a normalized plan. Empty when the shape looks fine.
 * Does not mutate the plan; callers append these to the tool result string.
 */
export function advisePlanDecomposition(plan: IPlanDocument): string[] {
  const warnings: string[] = [];

  walkItems(plan.items, (item) => {
    if (GATE_CHORE_TITLE.test(item.title)) {
      warnings.push(
        `"${item.title}" looks like a gate chore — drop it; the harness gate validates task_complete`
      );
    }
  });

  const top = plan.items;
  const layerTops = top.filter((item) => isLayerShapedTitle(item.title));

  if (top.length >= 3 && layerTops.length >= 3) {
    warnings.push(
      "plan looks layer-first (types/mocks/api/hooks/pages as separate items) — prefer vertical feature slices: one screen/feature end-to-end per item (seed→api→hook→UI→route), with contracts/tests nested under that slice"
    );
  }

  const sole = plan.items.length === 1 ? plan.items[0] : undefined;

  if (
    sole !== undefined &&
    sole.children === undefined &&
    ((sole.files !== undefined && sole.files.length > 1) ||
      /\band\b/iu.test(plan.goal))
  ) {
    warnings.push(
      "single top-level item with no children — prefer a parent feature + nested children for multi-part work"
    );
  }

  return warnings;
}
