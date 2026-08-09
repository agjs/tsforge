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

const MAX_FILES_PER_ITEM = 3;

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

/**
 * Advisory warnings for a normalized plan. Empty when the shape looks fine.
 * Does not mutate the plan; callers append these to the tool result string.
 */
export function advisePlanDecomposition(plan: IPlanDocument): string[] {
  const warnings: string[] = [];

  walkItems(plan.items, (item) => {
    if (item.files !== undefined && item.files.length > MAX_FILES_PER_ITEM) {
      warnings.push(
        `"${item.title}" lists ${String(item.files.length)} files — prefer ≤${String(MAX_FILES_PER_ITEM)}; split by module boundary`
      );
    }

    if (GATE_CHORE_TITLE.test(item.title)) {
      warnings.push(
        `"${item.title}" looks like a gate chore — drop it; the harness gate validates task_complete`
      );
    }
  });

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
