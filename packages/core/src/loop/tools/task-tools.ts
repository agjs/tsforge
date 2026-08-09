import type { IPlanDocument } from "../worklist/checklist.types";
import {
  completeItemInPlan,
  findItem,
  focusItemInPlan,
  formatPlanTree,
  loadPlan,
  savePlan,
  uncompleteItemInPlan,
} from "../worklist/checklist-store";
import { reject, str, type IToolContext } from "./tool-context";

function requirePlan(
  ctx: IToolContext
): { ok: true; planId: string; cwd: string } | { ok: false; error: string } {
  const planId = ctx.activePlanId;

  if (typeof planId !== "string" || planId.length === 0) {
    return {
      ok: false,
      error:
        "no active plan bound to this session — approve a plan in plan mode first",
    };
  }

  return { ok: true, planId, cwd: ctx.cwd };
}

function persistAndNotify(
  ctx: IToolContext,
  planId: string,
  plan: IPlanDocument,
  tool: "task_focus" | "task_complete" | "task_uncomplete"
): string {
  savePlan(ctx.cwd, plan);
  ctx.onPlanChanged?.(plan);
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `${tool}: plan ${planId} updated`,
  });

  return formatPlanTree(plan);
}

/** List the session-bound plan tree (status is tools-only; this is the mirror). */
export function doTaskList(
  _args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_list", bound.error);
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_list",
      `active plan file missing: ${bound.planId}`
    );
  }

  return formatPlanTree(plan);
}

/** Focus one open item (sets activeItemId + status active). */
export function doTaskFocus(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_focus", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_focus",
      "task_focus needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_focus",
      `active plan file missing: ${bound.planId}`
    );
  }

  const result = focusItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_focus", result.error);
  }

  const tree = persistAndNotify(ctx, bound.planId, result.plan, "task_focus");
  const item = findItem(result.plan.items, id);

  return [
    `focused: ${item?.title ?? id}`,
    item?.verify !== undefined ? `verify hint: ${item.verify}` : "",
    item?.detail !== undefined ? `detail: ${item.detail}` : "",
    "",
    tree,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Mark an item done ONLY when the acceptance gate is green.
 * Runs the same full evaluation as `check` / end-of-turn settle — refuses (and
 * leaves the item open) when the gate is red. The gate is the authority; the
 * checklist must not claim done ahead of it.
 */
export async function doTaskComplete(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_complete", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_complete",
      "task_complete needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_complete",
      `active plan file missing: ${bound.planId}`
    );
  }

  if (ctx.runTaskGate === undefined) {
    return reject(
      ctx,
      "task_complete",
      "no gate wired — cannot mark an item done without validation"
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: "task_complete: running gate before marking done",
  });

  const gate = await ctx.runTaskGate();

  if (!gate.passed) {
    const sample = gate.errors
      .slice(0, 5)
      .map((e) => e.message)
      .join("; ");
    const more =
      gate.errors.length > 5
        ? ` (+${String(gate.errors.length - 5)} more)`
        : "";

    return reject(
      ctx,
      "task_complete",
      `gate RED (${String(gate.errors.length)} error(s)) — item stays open. Fix, then task_complete again.${sample.length > 0 ? ` First: ${sample}${more}` : ""}`
    );
  }

  const result = completeItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_complete", result.error);
  }

  return persistAndNotify(ctx, bound.planId, result.plan, "task_complete");
}

/** Re-open a done item. */
export function doTaskUncomplete(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_uncomplete", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_uncomplete",
      "task_uncomplete needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_uncomplete",
      `active plan file missing: ${bound.planId}`
    );
  }

  const result = uncompleteItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_uncomplete", result.error);
  }

  return persistAndNotify(ctx, bound.planId, result.plan, "task_uncomplete");
}
