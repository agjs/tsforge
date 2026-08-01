import { proposePlan } from "./propose-plan";
import { writePlan } from "./plan-store";
import type { IProductPlan, IPlanConstraints, IPlanSchema } from "./plan-types";
import type { IProvider } from "../../inference";

export interface IPlanningDeps<TUi> {
  planner: IProvider;
  /** The stack's plan schema (prompt + example + UI validator + cross-slice rule), injected by the
   *  caller from the resolved stack adapter — this is what keeps the web plan shape out of core. */
  schema: IPlanSchema<TUi>;
  /** OPT-IN stack-specific planning constraints (guidance + reserved entities).
   *  Omitted → the planner is stack-agnostic. The BoringStack path supplies the
   *  BoringStack constants; a plain build passes nothing. */
  constraints?: IPlanConstraints;
  describe: () => Promise<{ description: string; mockups?: readonly string[] }>;
  review: (
    plan: IProductPlan<TUi>
  ) => Promise<
    | { action: "approve" }
    | { action: "revise"; note: string }
    | { action: "cancel" }
  >;
  out: (s: string) => void;
}

export async function runPlanning<TUi>(
  cwd: string,
  deps: IPlanningDeps<TUi>
): Promise<"approved" | "cancelled"> {
  const maxRevisions = 5;
  let revisionCount = 0;
  let currentInput = await deps.describe();

  while (revisionCount < maxRevisions) {
    const plan = await proposePlan(
      { planner: deps.planner },
      currentInput,
      deps.schema,
      deps.constraints ?? {}
    );

    if (plan === null) {
      deps.out("Failed to propose a plan. Please try again.");
      currentInput = await deps.describe();
      revisionCount++;
      continue;
    }

    const decision = await deps.review(plan);

    if (decision.action === "approve") {
      await writePlan(cwd, plan, "approved");

      return "approved";
    }

    if (decision.action === "cancel") {
      return "cancelled";
    }

    currentInput = {
      description: `${currentInput.description}\n\n${decision.note}`,
      mockups: currentInput.mockups,
    };
    revisionCount++;
  }

  return "cancelled";
}
