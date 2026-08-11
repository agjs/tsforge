/**
 * House (gate-aligned) convention library — how to write TypeScript/React the
 * gate will accept. Stack-agnostic: no BoringStack APIs. BoringStack composes
 * this with stack extras (data-fetching, i18n, …) and may override guides with
 * stack-specific wording.
 */

import type { IConventionProvider } from "../conventions-provider";
import { makeConventionProvider } from "./make-provider";

const HOUSE_TOPICS = [
  "component-anatomy",
  "file-layout",
  "jsx",
  "state",
  "no-casts",
  "forms",
  "lint-gotchas",
  "testing",
  "accessibility",
  "components-ui",
] as const;

export type HouseConventionTopic = (typeof HOUSE_TOPICS)[number];

export const HOUSE_TOPIC_RULES: Readonly<
  Record<HouseConventionTopic, readonly string[]>
> = {
  "component-anatomy": [
    "component-folder-structure",
    "one-component-per-file",
    "index-must-reexport-default",
  ],
  "file-layout": ["component-file-purity"],
  jsx: ["no-jsx-computation", "no-inline-jsx-functions"],
  state: ["no-state-in-component-body", "max-hooks-per-file"],
  "no-casts": ["no-restricted-syntax", "no-non-null-assertion"],
  forms: [],
  "lint-gotchas": [
    "await-thenable",
    "no-floating-promises",
    "no-confusing-void-expression",
    "no-error-stringify",
    "no-duplicate-string",
    // Bare names after topicForRule strips plugin prefixes.
    "naming-convention",
    "no-bare-date-now",
  ],
  testing: [
    "test-sibling-required",
    "test-file-mirrors-source",
    "no-focused-tests",
    "no-conditional-expect",
    "no-vacuous-expect",
    "no-real-network-in-unit-tests",
    "fake-timers-must-be-restored",
    "no-empty-function",
  ],
  accessibility: [
    "no-static-element-interactions",
    "click-events-have-key-events",
    "no-noninteractive-element-interactions",
    "label-has-associated-control",
    "interactive-supports-focus",
    "alt-text",
    "anchor-has-content",
    "heading-has-content",
    "aria-props",
    "aria-role",
    "aria-unsupported-elements",
    "role-has-required-aria-props",
    "role-supports-aria-props",
    "no-redundant-roles",
    "anchor-is-valid",
    "img-redundant-alt",
  ],
  "components-ui": [],
};

const HOUSE_GUIDES: Readonly<Record<HouseConventionTopic, string>> = {
  "component-anatomy":
    "COMPONENT ANATOMY. Put UI under `src/features/<feature>/` or `src/views/<name>/` " +
    "(pick ONE layout and stick to it — do not mix). A component folder needs the sibling " +
    "set the gate requires: `<Name>.tsx` (render props only), `<Name>.hooks.ts` (state/" +
    "effects), `<Name>.types.ts`, co-located test, and `index.ts` re-export. ONE component " +
    "per file. Shared primitives under `src/components/ui/` are often exempt from the full " +
    "sibling set — follow existing repo examples.",
  "file-layout":
    "FILE PURITY. A component `.tsx` holds ONLY imports + the component — no types, " +
    "constants, or helpers above it. Move types to `*.types.ts`, constants/maps to " +
    "`*.constants.ts`, pure helpers to `src/lib/`. Inline types/constants/helpers are a " +
    "gate error (component-file-purity).",
  jsx:
    "JSX. No COMPUTATION inside JSX — markup only READS already-computed values. Derive " +
    "in hooks (`useMemo`) or a pure helper. Simple ternaries are fine; `.map()`/`.filter()`/" +
    "arithmetic in markup is not. Every `<button>` needs explicit `type`. Handlers passed " +
    "to JSX props must be STABLE (`useCallback` / row child props) — inline arrows fail " +
    "`react/jsx-no-bind`.",
  state:
    "STATE. ALL `useState`/`useReducer`/`useEffect`/`useMemo`/`useCallback` live in " +
    "`*.hooks.ts`, never in the component body. Split oversized hooks files into focused " +
    "modules (e.g. queries + mutations).",
  "no-casts":
    "NO CASTS. Never write `x as T` or `x!`. Narrow with a TYPE GUARD: keep allowed values " +
    "in a const map (`as const` IS allowed) and guard with `in` — " +
    "`const S = {open:1,closed:1} as const; type St = keyof typeof S; " +
    "function isSt(v:string): v is St { return v in S; }`. For nullish DOM/query results, " +
    "`if (x === null) return` or `instanceof`, never `!`.",
  forms:
    "FORMS. Prefer react-hook-form + zodResolver in `*.hooks.ts`, not the component body. " +
    "Submit via `handleSubmit(onSubmit)` — do not invent a `FormEvent` handler. Keep Zod " +
    "fields required (no `.optional()`/`.default()` on form fields) and supply " +
    "`defaultValues`; type `useForm<z.infer<typeof schema>>`. Put defaults in " +
    "`*.constants.ts` typed as the form input — not bare `as const` arrays. If you wrap " +
    "RHF, make `Form` generic over `FieldValues` under `components/ui/` (purity-exempt).",
  "lint-gotchas":
    "STRICT-LINT GOTCHAS. Await promises you use (`no-floating-promises`); do not await " +
    "non-promises (`await-thenable`). Never take a value from a void expression. Pass " +
    "error objects to logs, never `String(err)`. Hoist heavily-repeated string literals. " +
    "Interfaces need an `I` prefix (`interface IPerson`, not `Person` — naming-convention). " +
    "No bare `Date.now()` / `Math.random()` — put `now()` (and an injectable clock) in " +
    "`src/lib/time.ts` (or `clock.ts` / `now.ts`); that file is allowlisted for " +
    "`tsforge/no-bare-date-now`.",
  testing:
    "TESTING. Every logic file needs a co-located test sibling. Use `.test.tsx` only when " +
    "the test renders JSX; `.test.ts` for pure logic — never both. No `.only`/`.skip`; no " +
    "`expect` inside conditionals; restore fake timers in `afterEach`. Placeholder " +
    "callbacks must be `vi.fn()`, not `() => {}`. Assert DOMAIN behavior (return values, " +
    'throws, state transitions) — never theater: `expect(typeof x).toBe("function")`, ' +
    "`expect(true).toBe(true)`, or a sole `toBeDefined`/`toBeTruthy` (no-vacuous-expect). " +
    "Mock network — never hit real endpoints in unit tests. When Vitest uses jsdom, install " +
    "`@types/jsdom` (or the scaffold's typed env) so `Could not find a declaration file for " +
    "module 'jsdom'` never appears. Do not leave unused `screen` / `waitFor` imports. " +
    "Adding `src/lib/time.ts` requires a co-located `time.test.ts`.",
  accessibility:
    "ACCESSIBILITY. Icon-only buttons need `aria-label`; decorative icons `aria-hidden`. " +
    "Never put `onClick` on a non-interactive `<div>`/`<span>` — use `<button type=" +
    '"button">`. Labels must associate with controls. Prefer accessible primitives over ' +
    "hand-rolled widgets.",
  "components-ui":
    "COMPONENTS UI. Prefer existing `src/components/ui/` primitives over hand-built " +
    "markup. Compose classNames with a merge helper (`cn`), not string concat. Do not " +
    "recreate primitives under a feature folder.",
};

const FORM_FIELDVALUES_FEEDBACK =
  /UseFormReturn|FieldValues|FormProvider|zodResolver|defaultValues/iu;

export const houseConventionProvider: IConventionProvider =
  makeConventionProvider({
    topics: HOUSE_TOPICS,
    guides: HOUSE_GUIDES,
    topicRules: HOUSE_TOPIC_RULES,
    messagePush: [{ topic: "forms", pattern: FORM_FIELDVALUES_FEEDBACK }],
  });

export function houseConventionTopics(): HouseConventionTopic[] {
  return [...HOUSE_TOPICS];
}

export function houseConventionGuide(topic: HouseConventionTopic): string {
  return HOUSE_GUIDES[topic];
}
