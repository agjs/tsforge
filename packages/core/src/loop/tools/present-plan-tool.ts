import { TOOL_NAME } from "../../agent";
import { countOpen } from "../worklist/checklist-store";
import { advisePlanDecomposition } from "../worklist/plan-advice";
import { planDocumentFromUnknown } from "../worklist/seed";
import type { IPlanDocument } from "../worklist/checklist.types";
import { reject, type IToolContext } from "./tool-context";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Prefix marking a SUCCESSFUL present_plan result the LOOP must treat as an execution
 *  boundary: the proposal is validated and rendered, so nothing is left for the model
 *  to do until the human approves or gives feedback — the send must END here. Without
 *  it, real models keep exploring in the same send and the human's "approve" typed
 *  meanwhile is swallowed as mid-send steering instead of binding the plan. Same
 *  distinctive-marker pattern as ASK_USER_SENTINEL (stripped before the model sees the
 *  result). Rejections return plain text so the model can revise in-send. */
export const PRESENT_PLAN_SENTINEL = "<<<PRESENT_PLAN>>>";

/** The clean model-facing message carried by a present_plan pause result (the result
 *  itself if it is not one). */
export function presentPlanMessage(result: string): string {
  return result.startsWith(PRESENT_PLAN_SENTINEL)
    ? result.slice(PRESENT_PLAN_SENTINEL.length)
    : result;
}

/** True ONLY for a genuine present_plan pause: the CALL was `present_plan` AND its
 *  result carries the sentinel. Gating on the call name (like shouldPauseForAskUser)
 *  stops any other tool result that happens to start with the marker from forging an
 *  end-of-send. */
export function shouldPauseForPresentPlan(
  callName: string,
  result: string
): boolean {
  return (
    callName === TOOL_NAME.presentPlan &&
    result.startsWith(PRESENT_PLAN_SENTINEL)
  );
}

/**
 * Build the raw draft object from tool args. Accepts either top-level
 * `{ goal, items }` or a nested `{ plan: { goal, items } }`.
 */
export function presentPlanArgsToRaw(
  args: Record<string, unknown>
): Record<string, unknown> | null {
  if (isRecord(args.plan)) {
    return args.plan;
  }

  if (Array.isArray(args.items)) {
    return {
      ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
      items: args.items,
    };
  }

  return null;
}

/**
 * `present_plan` — propose the session checklist for human approve.
 * Validates + normalizes; does NOT write disk until the user approves.
 * The REPL renders the proposal in the TUI via `onPlanPresented`.
 */
export function doPresentPlan(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const raw = presentPlanArgsToRaw(args);

  if (raw === null) {
    return reject(
      ctx,
      "present_plan",
      "present_plan needs `items` (array) and optional `goal`, or a `plan` object with those fields"
    );
  }

  const fallback =
    typeof ctx.task === "string" && ctx.task.length > 0 ? ctx.task : "goal";
  const normalized = planDocumentFromUnknown(raw, fallback);

  if (!normalized.ok) {
    return reject(ctx, "present_plan", normalized.error);
  }

  const plan: IPlanDocument = normalized.plan;

  ctx.onPlanPresented?.(plan);

  const open = countOpen(plan.items);
  const tops = plan.items.length;
  const advice = advisePlanDecomposition(plan);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `present_plan: ${tops} top-level · ${String(open)} open — awaiting approve`,
  });

  const base =
    `Plan presented to the human (${String(tops)} top-level item(s), ` +
    `${String(open)} open). Do NOT paste the JSON into chat again. ` +
    "Wait for them to approve (approve/go/lgtm) or reply with refinements — " +
    "then call present_plan again with the revised plan.";

  if (advice.length === 0) {
    return PRESENT_PLAN_SENTINEL + base;
  }

  return (
    PRESENT_PLAN_SENTINEL +
    `${base}\n\nDecomposition advice (optional revise via present_plan):\n` +
    advice.map((w) => `- ${w}`).join("\n")
  );
}
