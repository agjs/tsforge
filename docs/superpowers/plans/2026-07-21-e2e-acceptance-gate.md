# End-to-End Acceptance Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a harness-owned, plan-derived, browser end-to-end acceptance gate that drives real CRUD through the running UI and blocks feature-verify unless the feature is genuinely usable — closing the gate-parity hole that let build19 false-green with a hollow UI.

**Architecture:** Core derives a stack-agnostic `IAcceptanceSpec` from the approved `IProductPlan`. The BoringStack seam turns it into a Playwright suite generated into the app's `e2e/_acceptance/`, run via the app's own `@playwright/test`, reusing its `authedPage`/`testUser` fixtures. The build loop runs it per-slice (gating verify) and at final acceptance (full relational chain), turning failures into targeted steers.

**Tech Stack:** TypeScript, Bun, `bun:test`; Elysia + React + generated api-client + Drizzle in the generated app; `@playwright/test` 1.61.1 (already in the scaffold).

Spec: `docs/superpowers/specs/2026-07-21-e2e-acceptance-gate-design.md`.

## Global Constraints

- **Core stays stack-agnostic.** Nothing under `packages/core/src/loop/acceptance/**` (new, generic) may import from or reference BoringStack, Playwright, or app paths. All stack/Playwright specifics live under `packages/core/src/loop/boringstack/acceptance/**`.
- **Never relax the gate.** Additive only. The existing fast gate (compile + lint + size + knip + model tests) is unchanged.
- **Harness-owned.** The generated `apps/ui/e2e/_acceptance/**` is regenerated each run, excluded from the model's write scope (`setScope`), from knip entries, and from the fast-gate test run.
- **Flag-gated.** `TSFORGE_NO_E2E_ACCEPTANCE` kill-switch; default ON after Phase 5. When off, behavior is byte-identical to today.
- **Flake ≠ failure.** Assertion failure → feature red + steer. Browser-launch / connection failure → infra-abort (#47), never a feature red.
- **No `as` casts, no eslint-disable, cognitive-complexity ≤ 20, shared AST walkers** (house rules). Run full `bun run validate` before declaring a task done.
- **Determinism.** `Math.random`/`Date.now`/`new Date()` are unavailable in loop paths; sample values derive from the entity index.
- **Relationship parsing:** a relationship string `"belongsTo X"` → parent entity `X`, FK field `camelCase(X) + "Id"` (verified against build19: `companyId`/`contactId`/`dealId`).

---

## Task 1: Core acceptance-spec derivation (pure, stack-agnostic)

**Files:**
- Create: `packages/core/src/loop/acceptance/acceptance-spec.ts`
- Create: `packages/core/src/loop/acceptance/acceptance.types.ts`
- Test: `packages/core/tests/acceptance-spec.test.ts`

**Interfaces:**
- Consumes: `IProductPlan`, `ISlice`, `IEntitySpec` from `../planning/plan-types`.
- Produces:
  - `interface IAcceptField { name: string; type: string; optional: boolean; valid: string; invalid: string[] }`
  - `interface IParentRef { entity: string; key: string; fkField: string }`
  - `interface INegativeCase { field: string; value: string; why: string }`
  - `interface IEntityAcceptance { id: string; key: string; nav: string; fields: IAcceptField[]; shows: string[]; screens: readonly ("list"|"detail"|"form"|"dashboard")[]; parents: IParentRef[]; negatives: INegativeCase[]; acceptanceCheck: string }`
  - `interface IAcceptanceSpec { entities: IEntityAcceptance[] }`
  - `interface ITestIds { nav: string; list: string; empty: string; row: string; create: string; form: string; submit: string; rowEdit: string; rowDelete: string; confirmDelete: string; field(name: string): string; rowCell(name: string): string }`
  - `function testIdsFor(key: string): ITestIds`
  - `function planToAcceptanceSpec(plan: IProductPlan): IAcceptanceSpec`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { planToAcceptanceSpec, testIdsFor } from "../src/loop/acceptance/acceptance-spec";
import type { IProductPlan } from "../src/loop/planning/plan-types";

const plan: IProductPlan = {
  product: "CRM",
  slices: [
    { entity: { id: "Company", desc: "c", fields: [
        { name: "name", type: "string" },
        { name: "website", type: "string", optional: true } ],
        relationships: [], rules: ["name is required and non-empty"] },
      ui: { screens: ["list","form"], action: "add", shows: ["name","website"], nav: "Companies" },
      verification: { mustRemainTrue: ["x"], mustNotHappen: ["a company can be saved without a name"], acceptanceCheck: "create a company" } },
    { entity: { id: "Contact", desc: "c", fields: [
        { name: "name", type: "string" },
        { name: "email", type: "string" } ],
        relationships: ["belongsTo Company"], rules: ["email must be a valid email address"] },
      ui: { screens: ["list","form"], action: "add", shows: ["name","email","company"], nav: "Contacts" },
      verification: { mustRemainTrue: ["x"], mustNotHappen: ["a contact can be saved with an invalid email"], acceptanceCheck: "create a contact" } },
  ],
};

test("testIdsFor derives the stable contract from the entity key", () => {
  const t = testIdsFor("company");
  expect(t.list).toBe("company-list");
  expect(t.create).toBe("company-create");
  expect(t.field("name")).toBe("company-field-name");
  expect(t.rowDelete).toBe("company-row-delete");
});

test("planToAcceptanceSpec: entity key is camelCase, nav/shows/acceptanceCheck carried", () => {
  const spec = planToAcceptanceSpec(plan);
  const company = spec.entities[0];
  expect(company.key).toBe("company");
  expect(company.nav).toBe("Companies");
  expect(company.shows).toEqual(["name","website"]);
  expect(company.acceptanceCheck).toBe("create a company");
});

test("planToAcceptanceSpec: relationships parse to parent + fkField", () => {
  const contact = planToAcceptanceSpec(plan).entities[1];
  expect(contact.parents).toEqual([{ entity: "Company", key: "company", fkField: "companyId" }]);
});

test("planToAcceptanceSpec: negatives derive missing-required + bad-email", () => {
  const spec = planToAcceptanceSpec(plan);
  expect(spec.entities[0].negatives.some(n => n.field === "name" && n.value === "")).toBe(true);
  expect(spec.entities[1].negatives.some(n => n.field === "email" && n.value.length > 0 && !n.value.includes("@"))).toBe(true);
});

test("planToAcceptanceSpec: sample values are deterministic across calls", () => {
  expect(planToAcceptanceSpec(plan)).toEqual(planToAcceptanceSpec(plan));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test tests/acceptance-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `acceptance.types.ts` and `acceptance-spec.ts`**

`acceptance.types.ts` holds the interfaces listed under **Interfaces** above.

`acceptance-spec.ts`:

```ts
import type { IProductPlan, IEntitySpec } from "../planning/plan-types";
import type {
  IAcceptanceSpec, IEntityAcceptance, IAcceptField, IParentRef, INegativeCase, ITestIds,
} from "./acceptance.types";

function camel(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

export function testIdsFor(key: string): ITestIds {
  return {
    nav: `nav-${key}`, list: `${key}-list`, empty: `${key}-empty`, row: `${key}-row`,
    create: `${key}-create`, form: `${key}-form`, submit: `${key}-submit`,
    rowEdit: `${key}-row-edit`, rowDelete: `${key}-row-delete`, confirmDelete: `${key}-confirm-delete`,
    field: (name) => `${key}-field-${name}`, rowCell: (name) => `${key}-row-${name}`,
  };
}

// Deterministic valid sample per field, seeded off (entityIndex, fieldName) — no Date/random.
function validValue(field: { name: string; type: string }, seed: number): string {
  const isEmail = field.type === "email" || /email/i.test(field.name);
  if (isEmail) return `user${seed}@example.com`;
  if (field.type === "number") return String(seed + 1);
  if (/url|website/i.test(field.name)) return `https://example${seed}.com`;
  return `${field.name}-${seed}`;
}

function negativesFor(entity: IEntitySpec, fields: IAcceptField[]): INegativeCase[] {
  const out: INegativeCase[] = [];
  for (const f of fields) {
    if (!f.optional) out.push({ field: f.name, value: "", why: `${f.name} is required` });
    if (f.type === "email" || /email/i.test(f.name))
      out.push({ field: f.name, value: "not-an-email", why: "invalid email must be rejected" });
    if (f.type === "number")
      out.push({ field: f.name, value: "-1", why: "negative/invalid number must be rejected" });
  }
  return out;
}

function parseParents(relationships: readonly string[]): IParentRef[] {
  const out: IParentRef[] = [];
  for (const r of relationships) {
    const m = /^belongs\s*to\s+(\w+)/i.exec(r.trim());
    if (m) { const entity = m[1]!; out.push({ entity, key: camel(entity), fkField: `${camel(entity)}Id` }); }
  }
  return out;
}

export function planToAcceptanceSpec(plan: IProductPlan): IAcceptanceSpec {
  const entities: IEntityAcceptance[] = plan.slices.map((slice, i) => {
    const fields: IAcceptField[] = slice.entity.fields.map((f) => ({
      name: f.name, type: f.type, optional: f.optional ?? false,
      valid: validValue(f, i + 1), invalid: [],
    }));
    return {
      id: slice.entity.id, key: camel(slice.entity.id), nav: slice.ui.nav,
      fields, shows: [...slice.ui.shows], screens: slice.ui.screens,
      parents: parseParents(slice.entity.relationships),
      negatives: negativesFor(slice.entity, fields),
      acceptanceCheck: slice.verification.acceptanceCheck,
    };
  });
  return { entities };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test tests/acceptance-spec.test.ts` → PASS. Then `bun run validate` (lint/type) clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/acceptance packages/core/tests/acceptance-spec.test.ts
git commit -m "feat(acceptance): plan-derived acceptance spec + testid contract (core, stack-agnostic)"
```

---

## Task 2: Runner seam interface + result type (core)

**Files:**
- Modify: `packages/core/src/loop/acceptance/acceptance.types.ts`
- Test: `packages/core/tests/acceptance-result.test.ts`

**Interfaces:**
- Produces:
  - `type AcceptStep = "nav" | "list" | "create" | "persist" | "update" | "delete" | "negative" | "relationship"`
  - `interface IAcceptanceResult { entity: string; step: AcceptStep; ok: boolean; detail: string }`
  - `interface IAcceptanceOutcome { ok: boolean; results: IAcceptanceResult[]; detail?: string; infraError?: string }` (infraError set → infra-abort, not feature red; `detail` = a short top-level summary of why it failed)
  - `interface IAcceptanceRunner { run(entity: IEntityAcceptance, ctx: IAcceptanceRunCtx): Promise<IAcceptanceOutcome>; runChain(spec: IAcceptanceSpec, ctx: IAcceptanceRunCtx): Promise<IAcceptanceOutcome> }`
  - `interface IAcceptanceRunCtx { cwd: string; apiBase: string; uiBase: string }`
- This task only defines types + a pure `summarize(results): IAcceptanceOutcome` helper: `ok` = every result ok; on failure set `detail` to the FIRST failing result's detail; on EMPTY results set `ok=false` and `detail` to a clear "no acceptance checks ran" message; `detail` undefined when ok; never set `infraError` here. Core depends on `IAcceptanceRunner`; the seam implements it (Task 4/5).

- [ ] **Step 1: failing test** — `summarize` returns ok=false with the first failing step's detail; ok=true on all-pass.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement types + `summarize`.**
- [ ] **Step 4: `bun test tests/acceptance-result.test.ts` + `bun run validate`.**
- [ ] **Step 5: commit** `feat(acceptance): runner seam interface + outcome summarize`.

---

## Task 3: Testid contract — convention guide + change-scoped presence rule (seam)

**Files:**
- Create: `packages/core/src/loop/boringstack/acceptance/testid-contract.ts` (guide text builder from `ITestIds` + a `checkTestIds(featureFiles, ids): string[]` presence check)
- Modify: the BoringStack conventions/refine seam that front-loads guides (per memory `ws-b-count-only-and-ws-a-frontload`; locate the guide-registration site in `packages/core/src/loop/boringstack/`).
- Modify: `packages/core/src/loop/boringstack/gate-stages.ts` — add a change-scoped stage that fails with a clear message when a feature ships a page/form/row lacking the required testids.
- Test: `packages/core/tests/boringstack-testid-contract.test.ts`

**Interfaces:**
- Consumes: `testIdsFor` (Task 1).
- Produces: `buildTestIdGuide(key, ids): string`; `checkTestIds(sources: Map<string,string>, ids: ITestIds): string[]` (returns missing-testid messages; empty = pass).

- [ ] **Step 1: failing test** — given source strings missing `company-create`, `checkTestIds` reports it; given all present, returns `[]`. Guide text mentions each required testid.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement.** The gate-stage runs only on the feature's in-scope UI files; message: ``feature '{id}' UI is missing required test hooks: {list}. Add data-testid to the list, form, fields, and row controls so the app is testable.``
- [ ] **Step 4: tests + full `bun run lint` (type-aware) + `bun run validate`.**
- [ ] **Step 5: commit** `feat(acceptance): testid contract guide + change-scoped presence gate (boringstack seam)`.

---

## Task 4: E2E spec generator — single entity (seam)

**Files:**
- Create: `packages/core/src/loop/boringstack/acceptance/e2e-generator.ts`
- Test: `packages/core/tests/boringstack-e2e-generator.test.ts`

**Interfaces:**
- Consumes: `IEntityAcceptance`, `ITestIds`.
- Produces: `function generateEntitySpec(entity: IEntityAcceptance): string` — returns Playwright spec text (a `.spec.ts` string) using `@playwright/test`, the app's `authedPage` fixture, `getByTestId`, per-step `test(...)` blocks for nav/list/create/persist/update/delete/negative. `function specPath(cwd, key): string` → `apps/ui/e2e/_acceptance/${key}.spec.ts`.

- [ ] **Step 1: failing test** — `generateEntitySpec(company)` output contains: `getByTestId('company-create')`, fills `company-field-name`, clicks `company-submit`, asserts `company-row` visible; contains a reload+persist assertion; contains a negative block submitting empty `name` and asserting no new row; imports the app's fixture (`from "../fixtures/auth"`). Snapshot-lock the structure with targeted `expect(text).toContain(...)` assertions (not a full snapshot).
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement the generator** (string templating from the entity + `testIdsFor`). No relationship logic yet (Task 6).
- [ ] **Step 4: tests + `bun run validate`.** Additionally: manually write the generated spec for `Company` into valbuild19's `apps/ui/e2e/_acceptance/` and run `bunx playwright test _acceptance/company.spec.ts` against the booted stack → it must PASS for the real (usable) Company feature. Record the result in the task report.
- [ ] **Step 5: commit** `feat(acceptance): single-entity Playwright spec generator (boringstack seam)`.

---

## Task 5: E2E runner — invoke app Playwright + parse results (seam)

**Files:**
- Create: `packages/core/src/loop/boringstack/acceptance/e2e-runner.ts`
- Test: `packages/core/tests/boringstack-e2e-runner.test.ts`

**Interfaces:**
- Consumes: the shared `Exec` seam (`packages/core/src/loop/boringstack/exec.ts`), `generateEntitySpec`, `specPath`, `IAcceptanceRunner`/`IAcceptanceOutcome` (Task 2).
- Produces: `makeBoringstackAcceptanceRunner(exec: Exec): IAcceptanceRunner`. `run(entity, ctx)`: write the generated spec, `exec` the app's `bunx playwright test _acceptance/<key>.spec.ts --reporter=json` in `apps/ui`, parse the JSON reporter into `IAcceptanceResult[]` (map each Playwright test title → `AcceptStep`), classify launch/connection errors (no JSON, browser-launch stderr) as `infraError`. Bounded retries (2) on infra flake only.

- [ ] **Step 1: failing test** — with a fake `Exec` returning a canned Playwright JSON report (one passing, one failing test), `run` yields `IAcceptanceResult[]` with the right `ok`/`step`/`detail`; a fake `Exec` returning a browser-launch error yields `infraError` set and `ok=false` without feature-red results.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** (write spec via exec/fs seam, run, parse JSON reporter, classify).
- [ ] **Step 4: tests + `bun run validate`.**
- [ ] **Step 5: commit** `feat(acceptance): Playwright runner + JSON-report parsing + infra classification`.

---

## Task 6: Relationships + full-chain (seam + core)

**Files:**
- Modify: `packages/core/src/loop/boringstack/acceptance/e2e-generator.ts` (relationship-aware create: seed parent via API, select it in `{key}-field-{fkField}`, assert linkage cell) + `generateChainSpec(spec)` (Company→Contact→Deal→Activity end-to-end through the UI).
- Modify: `packages/core/src/loop/boringstack/acceptance/e2e-runner.ts` → implement `runChain`.
- Test: extend `boringstack-e2e-generator.test.ts` + `boringstack-e2e-runner.test.ts`.

- [ ] **Step 1: failing tests** — `generateEntitySpec(contact)` seeds a Company (API helper) and selects `contact-field-companyId`, asserts `contact-row-company`; `generateChainSpec` output creates all four in dependency order with linkage assertions.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: tests + `bun run validate`; live-run the generated chain spec against valbuild19 (Company passes end-to-end; hollow ones fail) and record.**
- [ ] **Step 5: commit** `feat(acceptance): relationship linkage flows + full-chain spec`.

---

## Task 7: Failure → steer (core)

**Files:**
- Create: `packages/core/src/loop/acceptance/acceptance-steer.ts`
- Test: `packages/core/tests/acceptance-steer.test.ts`

**Interfaces:**
- Consumes: `IAcceptanceOutcome`, `IEntityAcceptance`.
- Produces: `function acceptanceSteer(entity, outcome): string` — a targeted, generic (no stack strings) instruction naming the failed step + expectation, e.g. the CREATE example from the spec. Stack-flavored wording (e.g. "wire the create mutation to the form submit") is appended by the BoringStack refine seam, not here.

- [ ] **Step 1: failing test** — a CREATE-fail outcome yields a steer mentioning the entity, the create step, and "no row appeared"; an all-pass outcome yields empty string.
- [ ] **Step 2–4** implement + test + validate.
- [ ] **Step 5: commit** `feat(acceptance): outcome → targeted steer text`.

---

## Task 8: Wire per-slice verify gating into the build loop (seam)

**Files:**
- Modify: `packages/core/src/loop/boringstack/build.ts` (verify point ~L253-284): after a feature's fast gate is green and before marking verified, run `runner.run(entity, ctx)`; if `infraError` → infra-abort path (#47); if `!ok` → emit `acceptanceSteer` (+ seam wording) and keep the feature unverified so the loop iterates; only mark verified on `ok`.
- Modify: scope/knip exclusions so `apps/ui/e2e/_acceptance/**` is out of the model's `setScope` and not a knip/fast-gate entry.
- Add: `TSFORGE_NO_E2E_ACCEPTANCE` flag in the flags module; when set, skip the acceptance run entirely (verify behaves as today).
- Test: `packages/core/tests/boringstack-acceptance-wiring.test.ts` + pin-unchanged tests.

- [ ] **Step 1: failing tests** — with a fake runner returning `ok=false`, the feature is NOT marked verified and a steer is emitted; with `ok=true`, verified; with `infraError`, the infra-abort path fires (not a feature red); with the flag set, the runner is never called and verify matches today. Add/confirm tests pinning `unified-escalation`, `steer`, `checkpoint`, `fingerprint`, `session-gate`, and the existing `boringstack-build` behavior unchanged when the flag is off.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** the wiring behind the flag + inject the runner through the existing seam (mirror how the gate runner is injected, per memory `unified-loop-gate-seam` / `core-must-stay-stack-agnostic`).
- [ ] **Step 4: full suite `bun run validate` green; confirm pin-tests pass.**
- [ ] **Step 5: commit** `feat(acceptance): gate feature-verify on per-slice E2E acceptance (flagged)`.

---

## Task 9: Extend final acceptance + flake retries + infra-abort (seam)

**Files:**
- Modify: `packages/core/src/loop/boringstack/build.ts` (final-acceptance block ~L486-514): after the existing full validate + build + size checks, run `runner.runChain(spec, ctx)`; fold its outcome into the final GREEN/── decision; infra failures → infra-abort, not red.
- Test: extend `boringstack-acceptance-wiring.test.ts`.

- [ ] **Step 1: failing tests** — final acceptance is GREEN only if the existing checks AND the chain outcome pass; a chain assertion failure flips it to not-green with the chain detail surfaced; an infra error routes to infra-abort.
- [ ] **Step 2–4** implement + full `bun run validate`.
- [ ] **Step 5: commit** `feat(acceptance): full relational chain in final acceptance + flake/infra handling`.

---

## Task 10: Validation — the acceptance test of the acceptance gate

**Files:** none (a live proof + review), plus a short results note appended to the spec doc.

- [ ] **Step 1:** On a fresh clone (or by reverting valbuild19's Contact/Deal/Activity pages to their hollow state), run a live headless build with the flag ON. **Expected:** Contact/Deal/Activity go RED at verify with acceptance steers; the loop is forced to render real list + form + wire CRUD; Company passes without change. A build that previously false-greened must no longer reach "verified" while hollow.
- [ ] **Step 2:** Re-run the finished app's generated acceptance suite ≥3× to measure flake; the false-fail rate on genuinely-usable features must be ~0 (retries absorbing transient browser flake). Record numbers.
- [ ] **Step 3:** `harness-review --base main` on the whole branch; address Critical/Important findings.
- [ ] **Step 4:** Append the validation results (before/after verify behavior, flake numbers) to `docs/superpowers/specs/2026-07-21-e2e-acceptance-gate-design.md`.
- [ ] **Step 5: commit** `test(acceptance): live proof — hollow features now blocked at verify; flake budget recorded`.

---

## Self-review notes

- **Spec coverage:** selector contract (T1/T3), spec derivation (T1), E2E generator single+relationship+chain (T4/T6), runner+parse+infra (T5), steer (T7), per-slice verify wiring + flag + scope/knip exclusion (T8), final chain (T9), validation incl. re-running build19's hollow shape (T10). All spec components mapped.
- **Type consistency:** `IAcceptanceSpec`/`IEntityAcceptance`/`ITestIds`/`IAcceptanceRunner`/`IAcceptanceOutcome`/`IAcceptanceResult` defined once (T1/T2) and consumed unchanged downstream; `testIdsFor`/`planToAcceptanceSpec`/`generateEntitySpec`/`acceptanceSteer` signatures stable across tasks.
- **Core/seam boundary:** `loop/acceptance/**` (generic) never imports Playwright/BoringStack; all runtime/Playwright code is under `loop/boringstack/acceptance/**`.
