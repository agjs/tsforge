import { countOpen } from "../worklist/checklist-store";
import { advisePlanDecomposition } from "../worklist/plan-advice";
import { planDocumentFromUnknown } from "../worklist/seed";
import type { IPlanDocument } from "../worklist/checklist.types";
import { reject, type IToolContext } from "./tool-context";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    return base;
  }

  return (
    `${base}\n\nDecomposition advice (optional revise via present_plan):\n` +
    advice.map((w) => `- ${w}`).join("\n")
  );
}
