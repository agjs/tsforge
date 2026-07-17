# Hollow-UI Completeness Fix — Design Spec (task #50)

**Status:** step (1) — the refine-prompt CRUD contract (incl. API full-CRUD
requirement + UI test siblings) — is IMPLEMENTED and reviewer-gated. Steps (2)
mutations-first scaffold and (3) semantic reachability remain, pending an empirical
build to measure whether the contract alone suffices.

## Problem (verified)

The harness builds a BoringStack CRUD feature with a **complete API** (working
list/create routes + service, forced by a working scaffold + generated tests) but
a **hollow UI**: a list-only page with no create/edit/delete form, no confirmation,
no error/success toasts. The feature passes the gate anyway, and the model deletes
the translations it wrote (the i18n guard now blocks that, but the root remains).

### Root cause — API/UI scaffold asymmetry

| | API (`apps/api/scripts/codegen/new-resource.ts`) | UI (`apps/ui/scripts/codegen/new-feature.ts`) |
|---|---|---|
| Scaffold emits | WORKING list + create routes, service methods | BARE page (loading+empty only); `useCreate` STUB (returns input); empty query; no update/delete |
| Model's job | extend (add columns/logic) | **invent the entire UI from scratch** |
| Tests force it | generated route tests must pass | only a "renders heading" test |
| Reachability check | route mounted + schema table | UI route registered + `features.<x>.{title,empty}` present — **passes a hollow page** |
| Prompt | "service must implement listForUser + create" | "complete React feature slice" (vague) |

`reachability.ts:checkFeatureReachable` (tsforge) checks only: UI route registered,
API mounted, i18n title/empty present. `refine-prompt.ts:111-112` is vague. So a
page that renders "loading… / nothing here yet" satisfies everything.

## REVISED design (after 3-lens reviewer critique — 2026-07-17)

The full Option B (below) was reviewed and DESCOPED. Findings:
- **Gate-greenness:** a full List/Form/DeleteConfirm tree = ~24 files each needing
  the 5-sibling folder structure + no-state-in-tsx + no-inline-JSX-fns + complexity
  ≤ 20 + no-dead-i18n-keys + test siblings. Very high risk of a RED baseline; Form
  is the worst. "Mirror auth exactly" is insufficient.
- **Scope:** the real gap is the STUB mutations (`useCreate` returns input; no
  update/delete). A rigid skeleton also fights diverse entities (relations, enums).
- **Robustness (adversarial):** every enforcement layer is gameable by a determined
  drive-to-green model (keep placeholder field; delete scaffold files via `run`;
  vacuous tests; import-without-call). Same class as the i18n `run`-bypass.

**Decision:** don't chase airtight enforcement (that was the i18n 6-round spiral).
The model is LAZY, not adversarial — make the correct path the easy path:

1. **refine-prompt contract** (tsforge, pure prompt — build FIRST, lowest risk):
   replace vague "complete React feature slice" with an explicit per-field contract:
   "For EACH field under Display, add a form field; wire create + edit + delete with
   a confirm; surface errors via `t(features.<x>.<action>Error)`." Turns the passive
   nudge (refine-prompt.ts:165) into a contract. Cheap, high-leverage for a lazy model.
2. **mutations-first scaffold** (boringstack PR): real `useCreate/useUpdate/useDelete`
   (+ `.mutations.test.ts` sibling with `vi.mock` asserting the call). Shape-agnostic,
   ~1 file + test, low red-baseline risk. Removes the "invent CRUD wiring" gap.
3. **semantic reachability backstop** (tsforge, AST not substring): the feature page
   must CALL a mutation + render a form — version-gated on a scaffold marker so it
   can't false-fail builds on the old scaffold.
4. **DEFER** the full List/Form/DeleteConfirm component tree — too rigid + red-baseline
   risk. The contract + working mutations anchor the model to build them.

Sequencing: (1) now; (2) boringstack PR, verify a fresh `new:feature` is gate-green;
(3) after (2) bakes, gated on scaffold version. Incremental, small rollback surface.

---

## Original Option B (superseded by the revised design above; kept for reference)

## Fix — mirror the API: pre-generate a WORKING CRUD UI skeleton (Option B)

Make `new:feature` emit a gate-green, working CRUD UI the model EXTENDS (adds
domain fields) rather than invents — exactly how the API scaffold works. Pair with
generated UI tests that assert the mutations fire, so completeness is forced (as the
API's tests force it), and a reachability tightening as a backstop.

### What the scaffold emits (all gate-green out of the box)

Grounded in the starter's real pattern (`auth/LoginCredentialsForm`,
`MfaChallengeForm` — react-hook-form + zod). Per feature `<Name>`:

1. **`<Name>.mutations.ts`** — real `useCreate<Name>`, `useUpdate<Name>`,
   `useDelete<Name>` (currently only a `useCreate` stub). Each invalidates the list
   query on success; `onError` surfaces the error i18n key.
2. **`<Name>Form.tsx`** — create/edit form: one generic field (`name`) the model
   renames/extends, react-hook-form + zod, submit → `useCreate`/`useUpdate`, error
   rendered via `t("features.<x>.<action>Error")`.
3. **`<Name>List.tsx`** — renders query data in a table/list: shows the generic
   field + an Edit button (opens form) + a Delete button (opens confirm).
4. **`<Name>DeleteConfirm.tsx`** — confirm dialog → `useDelete`, `t(confirmDelete)`.
5. **`<Name>Page.tsx`** — composes List + Form (create/edit) + DeleteConfirm with
   view state (list | creating | editing) — not just loading/empty.
6. **i18n keys** (seed in every locale + `wire-resource.ts:addFeatureI18nKeys`):
   `title, empty, create, edit, delete, save, cancel, confirmDelete,
   createError, updateError, deleteError, createSuccess, updateSuccess,
   deleteSuccess` — all REFERENCED by the emitted components (so no unused-key
   churn; the i18n guard then protects them).
7. **Tests** — `<Name>Form.test.tsx` (renders fields, submit calls the create
   mutation), `<Name>List.test.tsx` (renders rows, delete opens confirm). These
   FORCE the model to keep the wiring real (they fail if it strips the form).

### tsforge-side backstop (`reachability.ts`)

Tighten `checkFeatureReachable` to also require the feature slice references the
CRUD mutations (`useCreate<Name>` / `useUpdate<Name>` / `useDelete<Name>`) and a
form — so a stripped-back page fails reachability, not just the i18n rule.

### refine-prompt

Replace the vague "complete React feature slice" with the explicit contract: the
skeleton exists; extend the Form fields to the real domain fields, wire each to a
mutation, keep the List/Delete/error-handling. (Prose reinforces; scaffold+tests
enforce.)

## Key risks (for reviewers)

1. **The scaffold skeleton MUST be gate-green as the baseline** (strict lint: no
   `as`, complexity ≤ 20, i18n every string, component-per-file, hooks rules). If
   the generated skeleton is red, every build starts red. This is the hardest part
   — mirror `auth` exactly.
2. **Generic field vs domain fields:** the skeleton ships one placeholder field
   (`name`); the model must extend to real fields. Does one generic field remove
   enough of the "invent from scratch" gap, or does the model still ship thin?
3. **Two repos:** scaffold change is a BoringStack PR (`new-feature.ts` +
   `wire-resource` i18n seeds); the reachability tightening + prompt are tsforge.
   Must land coordinated (scaffold first, else reachability tightening false-fails).
4. **Test-forces-completeness vs flakiness:** generated UI tests that assert
   mutation calls must be deterministic (mock the client) and not brittle.

## Alternatives considered

- **(A) Reachability static-scan only** (no scaffold change): brittle regex on
  JSX, and the model still invents from scratch → likely still thin. Weaker.
- **(C) Prompt-only:** proven insufficient (the model shortcuts under drive-to-green).

## Rollout

1. BoringStack PR: enhance `new-feature.ts` + i18n seeds; verify a fresh
   `new:feature` is gate-green (typecheck/lint/test/build). 2. tsforge PR:
   reachability tightening + refine-prompt. 3. Live build to measure UI realness.
