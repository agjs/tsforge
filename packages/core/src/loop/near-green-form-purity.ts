/**
 * Near-green rollback companion: when the checkpoint is a Form/FieldValues typing
 * error and the spray is mostly component-file-purity (dogfood Add-gamer thrash),
 * teach the atomic recipe instead of "don't re-introduce purity" alone.
 */
import type { IErrorItem } from "../validate/validate.types";

const FORM_FIELDVALUES =
  /UseFormReturn|FieldValues|FormProvider|zodResolver|defaultValues/iu;

const PURITY_OR_READONLY =
  /component-file-purity|inlineConstant|inlineType|inlineHelper|readonly\b|as const/iu;

/** Recipe appended to near-green rollback when Form typing + purity spray match. */
export const FORM_PURITY_ROLLBACK_RECIPE =
  "Form + purity spray recipe (do this as ONE coordinated change, not Form-only):\n" +
  "1. Make shadcn `Form` generic under `components/ui/`: " +
  "`function Form<T extends FieldValues>(props: UseFormReturn<T> & { children })`.\n" +
  "2. Put `defaultValues` in `<feature>.constants.ts` typed as the form input " +
  "(`CreateXInput` / `z.infer<typeof schema>`) — NOT bare `as const` (readonly arrays break RHF).\n" +
  "3. Wire the page last — do not dump consts into the page `.tsx` while chasing FieldValues alone.";

function blob(errors: readonly IErrorItem[]): string {
  return errors.map((e) => `${e.rule ?? ""} ${e.message}`).join("\n");
}

/** True when remaining checkpoint errors look like Form/FieldValues typing. */
export function checkpointLooksLikeFormTyping(
  checkpointErrors: readonly IErrorItem[]
): boolean {
  return FORM_FIELDVALUES.test(blob(checkpointErrors));
}

/** True when most of the spray delta is purity / readonly-defaults fallout. */
export function sprayLooksLikePurityUnmask(
  introduced: readonly IErrorItem[]
): boolean {
  if (introduced.length === 0) {
    return false;
  }

  const purityHits = introduced.filter((e) =>
    PURITY_OR_READONLY.test(`${e.rule ?? ""} ${e.message}`)
  ).length;

  return purityHits >= Math.ceil(introduced.length / 2);
}

/** Appendix for the rollback user message, or empty when the pattern does not match. */
export function formPurityRollbackAppendix(
  checkpointErrors: readonly IErrorItem[],
  introduced: readonly IErrorItem[]
): string {
  if (
    !checkpointLooksLikeFormTyping(checkpointErrors) ||
    !sprayLooksLikePurityUnmask(introduced)
  ) {
    return "";
  }

  return `\n\n${FORM_PURITY_ROLLBACK_RECIPE}`;
}
