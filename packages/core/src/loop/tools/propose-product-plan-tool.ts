import { reject, type IToolContext } from "./tool-context";

/**
 * `propose_product_plan` — propose a GREENFIELD product plan (entity/ui/
 * verification slices) for human approval. Validates + strips reserved
 * entities via `ctx.productPlanValidate` (a closure `runGreenfieldPlanning`
 * builds with the concrete stack schema in scope — this handler stays
 * schema-agnostic, same generic/specific split `proposePlan<TUi>` already
 * uses). Does NOT write disk until the user approves. The REPL renders the
 * proposal in the TUI via `onProductPlanProposed`.
 */
export async function doProposeProductPlan(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  if (ctx.productPlanValidate === undefined) {
    return reject(
      ctx,
      "propose_product_plan",
      "propose_product_plan is only available during greenfield product planning"
    );
  }

  const result = ctx.productPlanValidate(args);

  if (!result.ok) {
    return reject(ctx, "propose_product_plan", result.error);
  }

  await ctx.onProductPlanProposed?.(result.plan);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `propose_product_plan: ${String(result.plan.slices.length)} slice(s) — awaiting approve`,
  });

  return (
    "Plan proposed to the human. Do NOT paste the JSON into chat again. " +
    "Wait for them to approve (approve/go/lgtm) or reply with refinements — " +
    "then call propose_product_plan again with the revised plan."
  );
}
