import type {
  IWizardOption,
  IWizardState,
  IWizardStep,
} from "../render/wizard.types";
import type {
  IArchetype,
  IConfigField,
  IScaffoldAnswers,
  IScaffoldManifest,
} from "./scaffold.types";

type IStack = IScaffoldAnswers["stack"];

const ON_VALUES = new Set(["1", "true"]);

/** Fields the interactive wizard collects: the toggles/choices. Secrets and free
 *  text (project/domain/owner) are NOT wizard steps — secrets are derived by the
 *  planner (`requiredSecrets`) then prompted/generated at configure time, and
 *  rename params come from their own text prompts. Keeping the select-flow flat is
 *  the minimal-hardcoding path: every dependent consequence falls out of the
 *  planner, not branching wizard logic. */
function isSelectable(field: IConfigField): boolean {
  // STACK (dev/prod/smoke) is NOT a wizard question: you always scaffold to
  // develop, and prod/smoke are deploy/CI concerns. Its value comes from the
  // top-level `stack` answer (default "dev", overridable via `--stack`), so the
  // wizard never asks it — and stateToAnswers, which shares this predicate,
  // correctly skips it too (STACK is emitted from `answers.stack` in plan.ts).
  if (field.key === "STACK") {
    return false;
  }

  return (
    field.kind === "toggle" || field.kind === "one-of" || field.kind === "multi"
  );
}

function defaultFor(
  field: IConfigField,
  stack: IStack
): string | readonly string[] | undefined {
  return stack === "prod" ? field.prodDefault : field.devDefault;
}

function toggleStep(field: IConfigField, stack: IStack): IWizardStep {
  const def = defaultFor(field, stack);
  const on = typeof def === "string" && ON_VALUES.has(def);

  return {
    key: field.key,
    kind: "single",
    title: field.label,
    explanation: field.help ?? `Enable ${field.label}?`,
    evidence: [],
    options: [
      { label: "Enabled", value: "1", note: field.group },
      { label: "Disabled", value: "0" },
    ],
    defaultIndex: on ? 0 : 1,
  };
}

function oneOfStep(field: IConfigField, stack: IStack): IWizardStep {
  const options: readonly IWizardOption[] = (field.options ?? []).map((o) => ({
    label: o,
    value: o,
  }));
  // STACK *is* the chosen stack — default its step to `stack`, not the field's
  // dev-only default (else a --stack prod wizard would clobber STACK back to dev).
  const def = field.key === "STACK" ? stack : defaultFor(field, stack);
  const idx =
    typeof def === "string" ? options.findIndex((o) => o.value === def) : -1;

  return {
    key: field.key,
    kind: "single",
    title: field.label,
    explanation: field.help ?? `Choose ${field.label}.`,
    evidence: [],
    options,
    defaultIndex: idx >= 0 ? idx : 0,
  };
}

function multiStep(field: IConfigField, stack: IStack): IWizardStep {
  const options: readonly IWizardOption[] = (field.options ?? []).map((o) => ({
    label: o,
    value: o,
  }));
  const def = defaultFor(field, stack);
  const chosen = Array.isArray(def) ? new Set(def) : new Set<string>();

  return {
    key: field.key,
    kind: "multi",
    title: field.label,
    explanation: field.help ?? `Select ${field.label}.`,
    evidence: [],
    options,
    defaultChecked: options.flatMap((o, i) => (chosen.has(o.value) ? [i] : [])),
  };
}

/** Build a step visibility predicate from a field's `askWhen` token ("KEY=value").
 *  The wizard records toggles as "1"/"0", so a field gated on a toggle uses `KEY=1`.
 *  Absent or malformed → undefined (the step is always shown). */
function visibleWhenFor(
  askWhen: string | undefined
): ((state: IWizardState) => boolean) | undefined {
  if (askWhen === undefined) {
    return undefined;
  }

  // Split on the FIRST "=" only, so a value is never silently truncated. Require a
  // non-empty key AND value ("=v" / "KEY=" are malformed). parseManifest already
  // rejects these loudly; this stays defensive for any direct caller.
  const eq = askWhen.indexOf("=");

  if (eq <= 0) {
    return undefined;
  }

  const key = askWhen.slice(0, eq);
  const value = askWhen.slice(eq + 1);

  if (value.length === 0) {
    return undefined;
  }

  return (state) => state.single[key] === value;
}

function stepFor(field: IConfigField, stack: IStack): IWizardStep {
  if (field.kind === "toggle") {
    return toggleStep(field, stack);
  }

  if (field.kind === "multi") {
    return multiStep(field, stack);
  }

  return oneOfStep(field, stack);
}

/** Generate the wizard steps for an archetype from the manifest. Astro takes no
 *  further config (static site, no env); boringstack yields one select step per
 *  selectable field, in manifest order. A field with `askWhen` becomes a step that
 *  the wizard skips unless the gate matches. Pure — driven/tested via render/wizard. */
export function buildScaffoldSteps(
  manifest: IScaffoldManifest,
  archetype: IArchetype,
  stack: IStack
): readonly IWizardStep[] {
  if (archetype === "astro") {
    return [];
  }

  return manifest.fields.filter(isSelectable).map((field) => {
    const step = stepFor(field, stack);
    const visibleWhen = visibleWhenFor(field.askWhen);

    return visibleWhen === undefined ? step : { ...step, visibleWhen };
  });
}

/** Keys whose step is hidden for the given state (gate answered off). A hidden
 *  field must NOT contribute an answer — even if it was visited earlier and then
 *  hidden by flipping its gate back — so a later disable can't leave a stale value
 *  that the review never showed. Recomputed from the same askWhen→visibleWhen path
 *  buildScaffoldSteps uses, so projection and navigation agree on visibility. */
function hiddenKeys(
  manifest: IScaffoldManifest,
  archetype: IArchetype,
  stack: IStack,
  state: IWizardState
): ReadonlySet<string> {
  return new Set(
    buildScaffoldSteps(manifest, archetype, stack)
      .filter((s) => s.visibleWhen !== undefined && !s.visibleWhen(state))
      .map((s) => s.key)
  );
}

/** Read a finished (or partial) wizard state back into scaffold answers. Missing
 *  selections — and any field whose gate is off (see hiddenKeys) — are simply
 *  absent, so the planner falls back to the stack default. Safe on an un-driven
 *  state too. */
export function stateToAnswers(
  manifest: IScaffoldManifest,
  archetype: IArchetype,
  stack: IStack,
  state: IWizardState
): IScaffoldAnswers {
  const values: Record<string, string | readonly string[]> = {};

  if (archetype === "boringstack") {
    const hidden = hiddenKeys(manifest, archetype, stack, state);

    for (const field of manifest.fields.filter(isSelectable)) {
      if (hidden.has(field.key)) {
        continue; // gate is off — no answer, planner uses the default
      }

      if (field.kind === "multi") {
        const idxs = state.multi[field.key] ?? [];
        const opts = field.options ?? [];

        values[field.key] = idxs.flatMap((i) => {
          const v = opts[i];

          return v === undefined ? [] : [v];
        });
      } else {
        const v = state.single[field.key];

        if (v !== undefined) {
          values[field.key] = v;
        }
      }
    }
  }

  return { archetype, stack, values };
}
