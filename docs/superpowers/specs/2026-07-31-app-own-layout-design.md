# Scaffold ANY app in its OWN layout (BoringStack demo dashboard becomes disposable) — Design Spec

**Status:** approved by the user (2026-07-31). Reviewed by a Claude Plan subagent (adversarial critique, findings folded in) and now submitted to the tsforge 4-model `harness-review` panel for the review of record before implementation.

## Context

The tsforge harness can already build arbitrary **domain features** (any entities/relations/CRUD). What it CANNOT do is give the generated app its **own layout** — it force-wraps **every** feature into BoringStack's demo `AppShell` + global `AppSidebar` through **seven** hardcoded coupling points. So whatever the user asks for — a project tracker, a CRM, an inbox, a booking tool, a dashboard, anything — it comes out as links bolted onto the same showcase dashboard. BoringStack's dashboard is a **disposable showcase** (a fresh boot has something to click); it is not the frame every app must live in.

This is the missing half of "scaffold anything": the domain is already general, but the **layout is hardcoded**. A billion possible apps still resolve to a small set of **layout archetypes** (sidebar app, top-nav app, focused single-column, public/marketing, dashboard). Delivering an archetype-driven layout — plus not forcing the demo shell — is what makes the harness able to scaffold arbitrary apps for real. The `#213` work (sidebar grouping + home redirect) never questioned that the demo `AppShell` is the container, so it was lipstick on the wrong assumption; this spec undoes it.

**Confirmed with the user:**
- The scaffold's dashboard/account pages are **real capabilities** (Stripe billing, MFA, OAuth, team invites, audit log, notifications), not demo filler. **Keep them all**, relocated into a **Settings/Admin area** reached from the app via the header avatar/gear. Nothing deleted.
- The app the user asked for is **primary**, in its **own** layout, and is where you land. The demo dashboard is only present if the user actually wants a dashboard (an opt-in archetype).
- Deliver the **general** "layout archetype → layout descriptor" mechanism; implement the archetypes incrementally, proving the mechanism on **more than one shape of app**, not a single hardcoded example.

**Outcome:** the harness scaffolds the requested app in a layout that fits it, the demo dashboard is disposable/opt-in, and adding a new layout archetype is a small, well-bounded change rather than a rewrite.

---

## Architecture — one shell, archetype-driven nav-sets

Generating a *second* `AppShell` per app invites (a) import-name collisions in `routes.tsx`, and (b) re-providing the React context the account pages rely on (`AppPageHeaderProvider`, `AccountSwitcher`, `useMe`). Both are avoided by **reusing the existing `AppShell`** (keep its header/avatar/providers) and making the **archetype select which nav-set + wrapper the shell renders**:

- **App area** — the `AppShell` renders the **app nav-set** (the plan's feature slices) as its sidebar; header avatar/gear → Settings. The `home` slice is the post-login landing (reuse `#213` redirect). This is the app's own layout — its own nav, its own landing.
- **Settings/Admin area** — the same `AppShell` rendering the **account nav-set** (existing `/dashboard` + `/account/*` + `/notifications` links) plus a "← back to app" link. Account pages/routes untouched.
- **Nav-set ownership:** app-role features register in an **app nav-set** (scoped to the model); account/settings pages stay in the existing account nav-set (the current `APP_SIDEBAR_NAV_ITEMS`, repurposed). Which sidebar renders is chosen by route-area.
- **Layout descriptor** — one object per archetype parameterizing the seams. `dashboard` archetype = today's single-nav-set behavior (byte-identical, for apps that genuinely want a dashboard). `app-sidebar` = the app/settings split above. `routeWrapper` stays `<ProtectedRoute><AppShell>` for both (no second component, no collision); a future `public`/`focused`/`top-nav` archetype can vary `routeWrapper`, the nav mechanism, or drop `ProtectedRoute` — the abstraction is built to absorb them without touching the seams again.

### The seven coupling points (verified on `main`)
1. **Route wrapper** — `wire-resource.ts` `wireUiRouteFile()` L157-169 (the `<ProtectedRoute><AppShell><Suspense>` literal).
2. **Scope** — `build.ts` `scopeFor()` L162-180 + constants L108-143 (`APP_SIDEBAR_FILE`, `APP_ROUTES_FILE`, `APP_SIDEBAR_TEST_FILE`).
3. **Refine prompt** — `refine-prompt.ts` `layoutGuidance()` L8-38 + closing nav instruction ~L306.
4. **Nav-testid contract** — `acceptance/testid-contract.ts` `requiredTestIds`/`buildTestIdGuide`/`checkTestIds`.
5. **E2E nav step** — `acceptance/e2e-generator.ts` `generateEntitySpec()` ~L681-686 (`dashboard.goto()` + click `nav-<entity>`).
6. **Fast-gate sidebar test path** — `gate.ts` ~L70 hardcodes `... src/components/core/AppSidebar`. The app nav-set's test MUST be in this path or reachability goes unverified until final acceptance = false-green.
7. **Shell provisioning** — the harness assumes `AppShell`/`AppSidebar` exist and only appends; reuse resolves this, the nav-set split is the new wiring.

**Reuse as-is:** `#213` `homeRouteForPlan`/`wireHomeRedirectForPlan`/`applyHomeRedirect`; `plan-types.ts` `LAYOUT_ARCHETYPES`/`IMPLEMENTED_LAYOUT_ARCHETYPES`/`IUiIntent.layout+home`; `conventions.ts` guides; the existing `AppShell`/`AppSidebar`.

### How the layout decision is made (no new agent tools)
Two decision points, only one is judgment:
1. **Planner** (`propose-plan.ts`, existing LLM seam) picks the **archetype** per the product description, constrained to `IMPLEMENTED_LAYOUT_ARCHETYPES`, and emits it as `ui.layout`. It surfaces in the plan the **user approves** — the human is the backstop on the choice.
2. **Harness** (deterministic code) resolves `getLayoutDescriptor(layout)` and applies it: route wrapper, nav-set split, Settings area, home redirect, gate test path. No LLM, no guessing.

The **build agent gets NO new tools and NO layout discretion.** Its only layout-related action is adding its feature's nav link to the exact file the harness scoped + named in the refine-prompt. Rationale (hard lessons this session): every time the model *decided* load-bearing structure it went false-green/park (bolted onto the demo shell; home-redirect + FK-visibility had to be made deterministic). So: **archetype chosen once (planner, user-approved) → structure applied deterministically (harness) → agent fills in domain code only.**

### `ILayoutDescriptor`
```ts
interface ILayoutDescriptor {
  routeWrapper: { open: string; close: string };            // JSX around <FeaturePage/>; fixed AppShell for app-sidebar & dashboard (no 2nd import/alias/collision)
  sharedEditableGlobs: string[];                            // which shared files this feature may edit
  navRegistration: { promptGuidance: string; navFile: string | null; testId: (camel: string) => string };
  e2eNav: { startArea: "app" | "dashboard"; testId: (camel: string) => string };
  testIdContract: { navLocation: "app-navset" | "account-navset" };
  sidebarTestGlob: string;                                  // path the fast gate must run (seam #6)
}
export function getLayoutDescriptor(layout: LayoutArchetype): ILayoutDescriptor // throws on unknown
```

---

## Stages (each independently landable + panel-gated)

### Stage 1 — Descriptor abstraction (foundation, no behavior change)
New `layout-descriptor.ts`: `ILayoutDescriptor`, `getLayoutDescriptor`, descriptors for `app-sidebar` + `dashboard`. Pure, unit-tested; nothing calls it yet.

### Stage 2 — Thread the descriptor through all seven seams; `dashboard` reproduces today EXACTLY
Refactor each seam to read from the descriptor; call sites resolve `getLayoutDescriptor(slice.ui.layout ?? "app-sidebar")`. `scopeFor()` gains a `layout` param. `gate.ts` reads `sidebarTestGlob`. **Regression gate:** per-seam value-equality tests assert the `dashboard` descriptor's output equals today's hardcoded output — existing dashboard builds can't regress.

### Stage 3 — `app-sidebar` archetype end-to-end
- **Nav-set split (deterministic, plan-level, idempotent — like `applyHomeRedirect`):** point the `AppShell` sidebar at the app nav-set for app routes and the account nav-set for `/account`+`/dashboard`; add avatar/gear → Settings and a "← back to app" link (→ the `home` route, or app root). Harness-injected, NOT model-authored. Runs after the pristine gate baseline + `captureMetaBaseline` + infra fail-closed, skip-if-present.
- **Routing/scope/prompt:** app features register in the app nav-set; `scopeFor("app-sidebar")` grants the app nav-set + its test, not the account one. `refinePrompt` tells app features → app nav-set, **settings-role features → account nav-set**.
- **Reachability verified (no false-green):** the app nav-set has a nav-count/reachability test in `sidebarTestGlob`, run by the fast gate. Frozen-sibling coupling is the same already-handled pattern (#46/#65/#81), on the app nav-set.
- **E2E:** nav step uses `descriptor.e2eNav` (start in the app area, click the app link) instead of `dashboard.goto()`.

### Stage 4 — Plan schema + planner
Add `"dashboard"` to `LAYOUT_ARCHETYPES` **and** `IMPLEMENTED_LAYOUT_ARCHETYPES`. Default `IUiIntent.layout` → `app-sidebar`. Planner (`propose-plan.ts`) chooses the archetype from the product description (dashboard only when the user wants a dashboard); `plan-store.ts` already gates on the implemented set.

### Stage 5 — Tests + live proof of GENERALITY
Unit tests per seam (both descriptors) + regression (dashboard byte-equal) + split-wiring (idempotent, resume no-op, knip import-chain intact).
**Live acceptance across DIFFERENT apps (the point is generality, not any one app):**
- A **single-entity** feature app — lands on its own app area, settings reachable via gear, CRUD green.
- A **multi-slice relational** app (e.g. a small CRM: Company→Contact→Deal) — proves the app nav-set holds several features + relations, still its own layout, not the demo dashboard.
- A **`dashboard`-archetype** app — proves the legacy path is byte-unchanged.
Each: `boringstack done · N/N verified` + final acceptance green, and manual/e2e confirmation of app-area-primary + Settings/Admin intact.

---

## Critical files
- **New:** `layout-descriptor.ts` (+ tests); nav-set-split wiring (new fn mirroring `applyHomeRedirect`).
- **Modify:** `wire-resource.ts` (`wireUiRouteFile`), `build.ts` (`scopeFor` + `runBoringstackBuild` split call), `refine-prompt.ts` (`layoutGuidance` + closing instruction), `gate.ts` (sidebar test path from descriptor), `acceptance/testid-contract.ts`, `acceptance/e2e-generator.ts`, `planning/plan-types.ts` + `planning/propose-plan.ts`.
- **Reuse:** `homeRouteForPlan`/`wireHomeRedirectForPlan`/`applyHomeRedirect`, existing `AppShell`/`AppSidebar`, `conventions.ts` guides.

## Risks (biggest first)
1. **Fast-gate sidebar-test path (seam #6, false-green risk)** — the app nav-set's test MUST run in `gate.ts`, or reachability is unverified till final acceptance. Fixed via descriptor `sidebarTestGlob` + a test asserting the fast gate runs it.
2. **Backward compat** — `dashboard` descriptor must equal today's output; per-seam value-equality regression tests.
3. **Nav-set ownership boundary** — app features → app nav-set, settings features → account nav-set; the split-wiring routes each area's sidebar. Deterministic + idempotent, plan-level.
4. **Scope enforcement** — building an app feature must deny edits to the account/demo nav-set; scope-violation test.
5. **Resume-safety/ordering** — split + home redirect run plan-level after both pristine captures + infra fail-closed, skip-if-present (the `#213` ordering trap).
6. **Shared React context** — resolved by reusing `AppShell` (keeps `AppPageHeaderProvider`/`AccountSwitcher`/`useMe`); verify feature pages using `useAppPageHeader` still get it (same shell — they do).

## Verification
- Harness `bun run validate` green; unit + per-seam regression + split-wiring tests pass.
- Panel-gate every stage's PR via the 4-model `harness-review` (reviewers ok ≥ 2), as always.
- Live: the three different apps above each build to `N/N verified` + final acceptance green, land on their own app area (app nav only), and expose the real account pages via the gear-driven Settings/Admin area. Generality is the acceptance bar — a single app passing is necessary, not sufficient.
