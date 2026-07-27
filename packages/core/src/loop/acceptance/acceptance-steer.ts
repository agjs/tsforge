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
  const baseMessage =
    formCloseMessage(entity, firstFailure.detail) ?? stepMessage(entity, step);
  let detailSuffix = "";

  if (typeof outcome.detail === "string" && outcome.detail.length > 0) {
    detailSuffix = ` (${outcome.detail})`;
  } else if (firstFailure.detail.length > 0) {
    detailSuffix = ` (${firstFailure.detail})`;
  }

  return baseMessage + detailSuffix;
}

/**
 * The e2e create/update flow submits the form then waits for it to go HIDDEN
 * (`getByTestId('<key>-form').waitFor({ state: "hidden" })`) as the signal the
 * mutation + list refresh completed, BEFORE it asserts the new row. A form that
 * submits correctly but never closes fails HERE — Playwright reports
 * "waiting for … to be hidden … N × locator resolved to visible <form …>". The
 * failing step is then classified "create", whose generic message ("ensure the
 * create form OPENS") is the exact OPPOSITE of the real fix (it opened fine — it
 * won't CLOSE), which misdirects the model into chasing a non-existent
 * open/persist bug. Detect that signature from the raw detail and steer at the
 * true cause: close the form on a SUCCESSFUL mutation. Returns null when the
 * detail is not a form-didn't-close failure (caller falls back to stepMessage).
 */
function formCloseMessage(
  entity: IEntityAcceptance,
  detail: string
): string | null {
  const isFormStillVisible =
    /to be hidden/i.test(detail) && /resolved to visible/i.test(detail);

  if (!isFormStillVisible) {
    return null;
  }

  const { id, key } = entity;
  const singularKey = key.toLowerCase();

  return `The ${id} feature failed acceptance because the create/edit form did not close after a successful submit: the browser filled and submitted the form, but the form stayed visible (the e2e waits for it to disappear as the signal the mutation completed). The mutation itself is likely fine — the fix is to CLOSE the form on SUCCESS: hide it from the mutation's onSuccess, e.g. \`createMutation.mutate(input, { onSuccess: () => { closeForm(); } })\` where the page's view-state hook owns the \`showForm\` flag and \`closeForm\` sets it false. Do the same for the edit form. Do NOT re-work persistence — the new ${singularKey} will appear in the list once the form closes and the list refetches.`;
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

    default: {
      const _unreachable: never = step;

      return _unreachable;
    }
  }
}
