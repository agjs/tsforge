# Interactive Planning Phase (Spec-Driven Greenfield Builds) — Design

**Status:** approved-direction, pending spec review
**Date:** 2026-07-13

## Goal

Give the tsforge harness an **interactive, product-first planning phase** before the
greenfield build loop, so the model builds with real product context instead of a
one-line goal. For greenfield BoringStack builds, an approved plan is a **hard,
unavoidable precondition** of the build.

## Problem

The greenfield BoringStack build path builds **blind**. Confirmed in code today:

- `runBoringstackBuild` uses `{ spec: goal, features }` — the "spec" is the raw
  one-line goal, never elaborated (`loop/boringstack/build.ts`).
- `planResources` turns that one-liner into a **flat list of `{ id, desc }`** — an
  entity name plus one sentence (`loop/boringstack/plan-resources.ts`).
- `refinePrompt` gives the model **only `feature.id` + `feature.desc` + the last gate
  error** (`loop/boringstack/refine-prompt.ts`). It knows nothing about what the app
  is, what fields matter, how entities relate, what rules apply, or what the UI does.

This is the direct cause of observed quality failures — Bookmark dropped its
`description`, Expense dropped `priority` — the judge rejected them, but the model was
never given the information to build them right. It is guessing a product from a
sentence, on both the API and the UI side (the generated UI feature has no screen/flow
spec either).

## What already exists (reuse, don't rebuild)

- **BoringStack's Solo Spec Loop** (`tools/spec-loop/` in the BoringStack repo):
  a minimal spec-driven workflow — one living `.specs/next.md` (Problem / Design
  decisions + Slice / Verification contract), the loop `explore → slice → approve →
  build → learn`, a 5-question budget, and `solo_spec_gate` (a PreToolUse hook that
  **blocks source writes until `status: approved`**). `scripts/spec-init.ts` wires
  `.specs/next.md` + the command + the gate into a project.
- **The greenfield engine** (`loop/greenfield/`) already has the bones: `writeSpec`,
  a persisted `spec.md`, a planner returning `{ spec, features }`, resumable state,
  and role-based model routing (`plannerModel` / `workModel` / `evaluatorModel`).
- **Vision**: the harness can read images (`read_image`), so mockups/screenshots are
  first-class planning input.
- **The scaffold wizard** (`cli/repl-scaffold.ts`) — the infra setup the planning
  phase flows out of.

The gap is not machinery; it is that the BoringStack build path **bypasses the spec
layer** (`spec = goal`) and the harness never runs an interactive planning phase.

## Design

### The flow (greenfield BoringStack)

```
scaffold wizard (infra: name, features, admin)
        │
        ▼
"Describe your product"  ── text + mockups/screenshots (read via vision)
        │
        ▼
PLANNER role PROPOSES the plan  ── domain model + feature slices + screens/flows
        │  (≤ a few PRODUCT-level clarifying questions, only if genuinely ambiguous)
        ▼
Human reviews & approves / tweaks   ← the SINGLE human gate
        │
        ▼
Autonomous per-slice build  ── each slice built with the approved plan as context
```

The human speaks **product**; the model does the low-level derivation and **proposes**
the plan for approval. The user is **never** interrogated for entities, fields, or
screen layouts — that is the model's proposal, presented for approval, exactly like
Claude Code / Cursor / v0.

### The plan artifact

A single durable, human-approved **product plan** — the app-wide shared context:

- **Product**: one-paragraph purpose (problem-language).
- **Domain model**: entities with their fields (name + type), relationships, and key
  business rules. This is what makes a slice's build complete instead of vague.
- **Feature slices** (vertical: data + API + UI): each carries its entity detail AND
  its **UI intent** — screen kinds (list / detail / form / dashboard, matching
  BoringStack's conventional page shapes), the primary user action → observable result
  (the Solo Spec Loop *Event sketch*), key fields shown, and nav placement. Not
  pixel-level: BoringStack's shadcn system supplies the look.
- **Verification contract** per slice (adopted from Solo Spec Loop): must-remain-true
  invariants + at least one must-not-happen negative + an outcome-oriented acceptance
  check. This feeds the reject-by-default judge.
- Frontmatter carries `status:` (`draft` → `approved`), honoring the same gate contract
  as `.specs/next.md`.

tsforge implements the Solo Spec Loop **contract natively** (produces/consumes the
`.specs` artifact + honors the approval gate) rather than shelling out to BoringStack's
Claude-Code plugin — so it stays model-agnostic and works with the local build model.

### Roles (model-agnostic, config-routed)

- A first-class **planner** role, config-routed like `workModel`. Default
  `deepseek-4-pro`; **swappable to local or any model** at any time via config — no
  hardcode.
- A **reviewer** role is a planned follow-on (not in this spec's scope).

### Enforcement — an approved plan is mandatory for greenfield BoringStack

1. **The wizard flows straight into planning** — no separate "just build" door;
   planning is the next screen after the wizard.
2. **The build loop refuses to generate a feature without an approved plan on disk**
   — lifting `solo_spec_gate`'s "no source writes until approved" to the harness level.
   Landing at the build step without an approved plan drops the user into planning, not
   a blind build.
3. **REPL interception**: typing "build me X" on a fresh BoringStack project routes X
   into the planner as the product description, not to the build loop.
4. **Headless/automation must supply a pre-approved plan** (`--plan <file>`); with none,
   it refuses. The only way to go fast is to bring a plan — never to build without one.
   This preserves unattended 24/7 runs (plan once, then it runs).
5. **Brownfield stays optional** — editing an existing repo already has the code as
   context; the mandate is greenfield-from-scratch specifically.

### Context threading (the fix)

The approved plan becomes shared context injected into **every** feature build:
`refinePrompt` receives the product summary + domain model + this slice's entity detail
(fields, relationships, rules) + its UI intent + its verification contract — replacing
today's lone one-line `feature.desc`. This is the context whose absence caused
blind-building.

## Components

**Modify:**
- `loop/boringstack/plan-resources.ts` — the planner produces a **rich plan** (domain
  model + per-slice entity/UI detail + verification contract), from a product
  description + mockups, via the planner role. Replaces the flat `{id, desc}` list.
- `loop/boringstack/build.ts` (`runBoringstackBuild`) — require an approved plan;
  derive slices from it; pass the plan through as build context. Stop using `spec = goal`.
- `loop/boringstack/refine-prompt.ts` — inject the product context + slice detail + UI
  intent + verification contract.
- `cli/repl-scaffold.ts` / the REPL — flow the wizard into planning; intercept a
  greenfield "build me X".
- `models-config` — a first-class `planner` role (default `deepseek-4-pro`, swappable).
- The write-guard / build precondition — enforce "no feature build without an approved
  plan" (the harness-level `solo_spec_gate`).
- `scripts/headless-build.ts` — `--plan <file>`; refuse a greenfield build without one.

**Reuse (no change):** the greenfield engine's state/resume/freeze; vision `read_image`;
the scaffold clone/configure; BoringStack's `.specs`/gate contract.

## Verification

- Unit: planner produces a rich plan from a description (fake planner model); the plan
  threads into `refinePrompt` (assert product context + fields + UI intent + contract
  present); the build precondition refuses without an approved plan and accepts with one;
  headless refuses without `--plan`.
- Integration: a real interactive planning session proposes a plan the user approves,
  then a build that carries the context — the judge no longer rejects for missing
  fields/UI the plan specified.
- End-to-end: the earlier failure cases (Bookmark/Expense dropping fields) build
  complete when the plan specified those fields.

## Not doing / deferred

- The **reviewer** role (planned follow-on).
- Full UX spec (component-level layouts/states) — capability-level UI intent only.
- Brownfield mandatory planning — optional there.
- Per-slice human approval during build — one gate on the plan, then autonomous.
