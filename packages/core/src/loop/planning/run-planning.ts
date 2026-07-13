import { proposePlan } from "./propose-plan";
import { writePlan } from "./plan-store";
import type { IProductPlan } from "./plan-types";
import type { IProvider } from "../../inference";

export interface IPlanningDeps {
  planner: IProvider;
  describe: () => Promise<{ description: string; mockups?: readonly string[] }>;
  review: (
    plan: IProductPlan
  ) => Promise<
    | { action: "approve" }
    | { action: "revise"; note: string }
    | { action: "cancel" }
  >;
  out: (s: string) => void;
}

export async function runPlanning(
  cwd: string,
  deps: IPlanningDeps
): Promise<"approved" | "cancelled"> {
  const maxRevisions = 5;
  let revisionCount = 0;
  let currentInput = await deps.describe();

  while (revisionCount < maxRevisions) {
    const plan = await proposePlan({ planner: deps.planner }, currentInput);

    if (plan === null) {
      deps.out("Failed to propose a plan. Please try again.");

      if (revisionCount < maxRevisions) {
        currentInput = await deps.describe();
        revisionCount++;
        continue;
      }

      return "cancelled";
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
