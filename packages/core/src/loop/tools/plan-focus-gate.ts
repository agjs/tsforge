import { TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../../agent";
import { loadPlan } from "../worklist/checklist-store";
import type { IToolContext } from "./tool-context";

const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.taskList,
  TOOL_NAME.taskFocus,
  TOOL_NAME.taskComplete,
  TOOL_NAME.taskUncomplete,
  TOOL_NAME.taskAdd,
  TOOL_NAME.taskUpdate,
]);

const FOCUS_NEEDED =
  "focus an open checklist item with task_focus before changing the workspace";

/**
 * When a plan is bound, workspace mutations require a focused item.
 * Task tools (including task_focus) and read-only tools always pass.
 */
export function planFocusReject(
  toolName: string,
  ctx: IToolContext
): string | null {
  const planId = ctx.activePlanId;

  if (typeof planId !== "string" || planId.length === 0) {
    return null;
  }

  if (TASK_TOOL_NAMES.has(toolName) || READ_ONLY_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const plan = loadPlan(ctx.cwd, planId);

  if (plan !== null && typeof plan.activeItemId === "string") {
    return null;
  }

  return FOCUS_NEEDED;
}
