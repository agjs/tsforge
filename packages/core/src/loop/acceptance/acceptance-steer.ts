import type {
  IEntityAcceptance,
  IAcceptanceOutcome,
  AcceptStep,
} from "./acceptance.types";

/**
 * Generate a targeted, stack-agnostic steer from an acceptance outcome.
 * - All-pass (outcome.ok === true) → ""
 * - Failure → instruction naming entity, first failing step, and concrete expectation
 *   with a clear sentence per step type. Stack-flavored wording is appended by seams.
 * - Includes outcome.detail if present for supporting context.
 *
 * Cognitive complexity kept ≤ 20 via flat step→sentence map.
 */
export function acceptanceSteer(
  entity: IEntityAcceptance,
  outcome: IAcceptanceOutcome
): string {
  if (outcome.ok) {
    return "";
  }

  const firstFailure = outcome.results.find((r) => !r.ok);

  // If no failing result but outcome.ok is false, all results passed but required steps are missing.
  // Use outcome.detail to explain what's missing (set by summarize).
  if (firstFailure === undefined) {
    if (typeof outcome.detail === "string" && outcome.detail.length > 0) {
      return outcome.detail;
    }

    // Fallback if detail is missing (shouldn't happen)
    return "acceptance incomplete: missing required steps";
  }

  const step = firstFailure.step;
  const baseMessage = stepMessage(entity, step);
  let detailSuffix = "";

  if (typeof outcome.detail === "string" && outcome.detail.length > 0) {
    detailSuffix = ` (${outcome.detail})`;
  } else if (firstFailure.detail.length > 0) {
    detailSuffix = ` (${firstFailure.detail})`;
  }

  return baseMessage + detailSuffix;
}

function stepMessage(entity: IEntityAcceptance, step: AcceptStep): string {
  const { id, key } = entity;
  const singularKey = key.toLowerCase();

  switch (step) {
    case "nav": {
      return `The ${id} feature failed acceptance at the nav step: the menu link to ${id}s was not accessible. Make sure the ${id} navigation link is visible and clickable in the main menu.`;
    }

    case "list": {
      return `The ${id} feature failed acceptance at the list step: the ${singularKey} list did not render. Make sure the ${singularKey} list view displays all ${singularKey} records.`;
    }

    case "create": {
      return `The ${id} feature failed acceptance at the create step: the create button or form for adding a ${singularKey} was not visible. Add the create button to the ${singularKey} list, and ensure the create form opens when clicked.`;
    }

    case "persist": {
      return `The ${id} feature failed acceptance at the persist step: after filling and submitting the create form, the new ${singularKey} did not appear in the list. Make the create form actually persist a new ${singularKey} and render it in the list.`;
    }

    case "update": {
      return `The ${id} feature failed acceptance at the update step: changes to an existing ${singularKey} did not persist. Make sure edit functionality saves and reflects changes in the ${singularKey} list.`;
    }

    case "delete": {
      return `The ${id} feature failed acceptance at the delete step: a deleted ${singularKey} was not removed from the list. Ensure the delete function removes the ${singularKey} from the list view.`;
    }

    case "negative": {
      return `The ${id} feature failed acceptance at the negative step: invalid or empty inputs were accepted when they should have been rejected. Add validation to reject empty required fields and invalid data formats.`;
    }

    case "relationship": {
      return `The ${id} feature failed acceptance at the relationship step: the ${singularKey} was not properly linked to its parent. Ensure parent selection works and the relationship is correctly saved.`;
    }

    default: {
      const _unreachable: never = step;

      return _unreachable;
    }
  }
}
