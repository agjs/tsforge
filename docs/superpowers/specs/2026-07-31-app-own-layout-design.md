# Scaffold ANY app in its OWN layout (BoringStack demo dashboard becomes disposable) — Design Spec v2

**Status:** approved by the user (2026-07-31). v1 was BLOCKED by the tsforge 4-model panel; v2 addresses every critical/major finding (two-axis model, opt-in default preserving backward-compat, deterministic route-area, existing `settings` archetype folded in, landable re-sequenced stages, gate/e2e/home plumbed against real code). Re-submitted to the panel for the review of record before implementation.

## Context

The tsforge harness already builds arbitrary **domain features** (any entities/relations/CRUD). What it CANNOT do is give the generated app its **own layout** — it force-wraps **every** feature into BoringStack's demo `AppShell` + global `AppSidebar` through **seven** hardcoded coupling points. So whatever the user asks for comes out as links bolted onto the same showcase dashboard. BoringStack's dashboard is a **disposable showcase**, not the frame every app must live in. A billion possible apps still resolve to a small set of **layout archetypes**; delivering archetype-driven layout — plus not forcing the demo shell — is what makes "scaffold anything" real. `#213` (sidebar grouping + home redirect) never questioned that the demo `AppShell` is the container; this spec undoes that.

**Confirmed with the user:** the scaffold's dashboard/account pages are **real capabilities** (Stripe billing, MFA, OAuth, team, audit, notifications) — keep them all, relocated into a **Settings/Admin area** reached via the header avatar/gear; nothing deleted. The requested app is **primary**, in its **own** layout, and is where you land. Deliver the **general** mechanism; prove it on **several different apps**, not one example.

---

## Two axes (the v1 critical fix)

v1 overloaded `IUiIntent.layout`, which on `main` already means **nav placement within the one shell** (`app-sidebar` | `settings`). Shell choice and per-feature nav placement are **different axes**:

- **`IProductPlan.shellLayout?: ShellLayout`** — PLAN-level. `ShellLayout = "dashboard" | "app-sidebar"`. **Absent → `"dashboard"` = today's EXACT single-shell behavior** (backward-compat; no existing plan changes). `"app-sidebar"` = the app owns its layout (app area + Settings/Admin area split). The **planner emits `shellLayout` for every new plan** (`app-sidebar` for normal apps, `dashboard` only when the product IS a dashboard) — so new apps get their own layout by default, while stored/legacy plans with no field rebuild identically.
- **`IUiIntent.navRole?: "app" | "settings"`** — SLICE-level, default `"app"`. Only meaningful when `shellLayout === "app-sidebar"`: which nav-set the feature's link joins (primary app nav vs the Settings/Admin nav). Under `shellLayout: "dashboard"` it is ignored (one nav-set, today's behavior).
- **Legacy `IUiIntent.layout` migration:** keep the field readable; `parsePlan` maps a legacy `layout: "settings"` → `navRole: "settings"`, `layout: "app-sidebar"` → `navRole: "app"`. `layout` no longer selects a shell. The existing `settings` archetype thus becomes a **navRole**, not a shell — resolving the "`getLayoutDescriptor` throws on settings" critical. `LAYOUT_ARCHETYPES`/`IMPLEMENTED_LAYOUT_ARCHETYPES` are retired/renamed to the two-axis types.

**Descriptor is keyed by the PLAN's `shellLayout`, not per-slice** — resolving the mixed-plan ambiguity (which descriptor drives the shared shell, gate, e2e). Per-slice `navRole` only selects the nav-set within the app-sidebar shell.

---

## Architecture — reuse the existing AppShell; route-area chosen deterministically at wire-time

Generating a second `AppShell` invites import collisions + re-providing the account pages' React context (`AppPageHeaderProvider`, `AccountSwitcher`, `useMe`). Instead **reuse the existing `AppShell`** and make it render one of two nav-sets, selected by an **explicit prop set at wire-time** (NOT runtime URL-prefix guessing — that was a v1 critical: `/notifications` isn't under `/account`, and generated apps can collide with `/dashboard`):

- The route wrapper passes `<AppShell navSet="app">` for app-role feature routes and `<AppShell navSet="account">` for the scaffold's account/dashboard/notifications routes. `AppShell` renders the app `AppSidebar` variant or the account one from that prop — deterministic, per-route, collision-proof, and covers the mobile `Sheet` the same way.
- **App area:** `AppShell navSet="app"` + the **app nav-set** (feature slices with `navRole:"app"`); header avatar/gear → Settings. Post-login lands on the app (see Home below).
- **Settings/Admin area:** `AppShell navSet="account"` + the **account nav-set** (the current `APP_SIDEBAR_NAV_ITEMS`: dashboard/notifications/team/audit/settings/billing/profile) + a "← back to app" link. Account pages/routes untouched.
- **`shellLayout: "dashboard"`** keeps exactly one nav-set (`navSet="app"` for all, pointing at today's single `APP_SIDEBAR_NAV_ITEMS`) → byte-identical to today.

### The seven coupling points (verified `main`) + the new axis threading
1. **Route wrapper** — `wire-resource.ts` `wireUiRouteFile()` (L133-187): emit `<ProtectedRoute><AppShell navSet={role}>…` where `role` derives from the slice's `navRole` under `app-sidebar`, else today's literal. `wireUiRouteFile` gains a descriptor/navSet arg.
2. **Scope** — `build.ts` `scopeFor()` (L162-180): gains a `(name, shellLayout, navRole)` signature; under `app-sidebar`+`navRole:"app"` grants the **app nav-set file + its test** (not the account sidebar); under `dashboard` returns today's globs exactly.
3. **Refine prompt** — `refine-prompt.ts` `layoutGuidance()`/closing instruction: tell an `app` feature to register in the app nav-set, a `settings` feature in the account nav-set. Descriptor-driven text.
4. **Nav-testid contract** — `acceptance/testid-contract.ts`: `nav-<entity>` required on whichever nav-set the feature's `navRole` selects.
5. **E2E** — `acceptance/e2e-generator.ts`: `authedPage.dashboard.goto()` appears at MANY step sites (nav/list/create/update/delete/negatives), not just L681-686. Add an **app-area landing helper** (`authedPage.app.goto()` → the app home route). App-role specs start there; settings-role specs keep `dashboard.goto()`. All goto sites are parameterized by the feature's area.
6. **Fast-gate sidebar test path** — `gate.ts` `runBoringstackGate` builds a single project-wide `FAST_GATE` with hardcoded `src/components/core/AppSidebar`. The gate is project-wide (no slice arg), so it must run the **union**: the account sidebar test ALWAYS + the app nav-set test when `plan.shellLayout==="app-sidebar"`. `shellLayout` reaches the gate at the plan/build level (available in `runBoringstackBuild`), not per-slice.
7. **Shell provisioning** — reuse the existing `AppShell`/`AppSidebar`; the new wiring is the nav-set split + the app nav-set constant + its test (below).

### Nav-set split — code-level (v1 "not designed at the mutation level" fix)
Deterministic, plan-level, idempotent (marker-guarded, skip-if-present), harness-injected (NOT model-authored), run in `runBoringstackBuild` AFTER the pristine gate baseline + `captureMetaBaseline` + infra fail-closed (the `#213` ordering trap), only when `shellLayout==="app-sidebar"`:
- **`AppSidebar`:** split today's `APP_SIDEBAR_NAV_ITEMS` into `ACCOUNT_NAV_ITEMS` (the existing 7) and a new empty `APP_NAV_ITEMS` (feature links append here). `AppSidebar` takes the `navSet` prop and renders the matching list (desktop + mobile `Sheet` parity). Keep `ACCOUNT_NAV_ITEMS` referenced so knip is satisfied; the empty `APP_NAV_ITEMS` is referenced by the `navSet==="app"` branch (import chain intact).
- **App nav-set test:** ships with an initial assertion (baseline link count = 0/however the scaffold seeds it) at the path `gate.ts` runs (seam #6); each app feature bumps it (same already-handled frozen-sibling pattern #46/#65/#81).
- **AppShell:** avatar/gear → Settings (`/account/profile`); the account variant gets a "← back to app" link → the app home route.
- **Resume mid-migration:** the split is marker-guarded so a resumed build doesn't re-split or clobber model-added `APP_NAV_ITEMS` entries.

### Home (v1 "lands in Settings" fix)
`homeRouteForPlan` today returns null when no slice has `home:true`, leaving `DEFAULT_REDIRECT_TO = /dashboard` (which becomes the Settings area). Under `shellLayout: "app-sidebar"`, if no explicit `home`, **default the redirect to the first `navRole:"app"` slice's route** — never `/dashboard`. So an app-sidebar app always lands in the app area.

### How the decision is made (no new agent tools)
Planner picks `shellLayout` (+ per-slice `navRole`), user-approves the plan. Harness applies the shell descriptor deterministically. The build agent gets **no new tools and no layout discretion** — it only adds its feature's nav link to the nav-set file the harness scoped + named. (Hard lesson this session: model-decided load-bearing structure → false-green/park.)

### `IShellDescriptor` (keyed by shellLayout)
```ts
type ShellLayout = "dashboard" | "app-sidebar";
type NavRole = "app" | "settings";
interface IShellDescriptor {
  navSetFor: (role: NavRole) => "app" | "account";          // which AppShell nav-set the route uses
  navFileFor: (role: NavRole) => string;                    // the nav-set file the feature edits
  sidebarTestGlobs: string[];                               // union the fast gate must run (seam #6)
  e2eStartFor: (role: NavRole) => "app" | "dashboard";      // e2e landing helper
  splitsNavSets: boolean;                                   // app-sidebar=true, dashboard=false (today)
}
export function getShellDescriptor(shell: ShellLayout): IShellDescriptor // throws on unknown
```
The `dashboard` descriptor maps every role to today's single nav-set/file/test/e2e (byte-identical). Honest scope note: this descriptor covers `{dashboard, app-sidebar}` only. Future `public`/`focused`/`top-nav` need additional fields (auth boundary, shell presence, nav mechanism, provisioning) — documented as explicit extension points, NOT claimed-covered now (v1 over-claimed generality).

---

## Stages (re-sequenced so each is real, landable, no dead code, no default-flip)

### Stage 1 — Two-axis schema + backward-compat (no behavior change)
Add `IProductPlan.shellLayout` + `IUiIntent.navRole`; migrate legacy `layout` (`parsePlan` maps to `navRole`); retire `LAYOUT_ARCHETYPES`/`IMPLEMENTED_LAYOUT_ARCHETYPES` into the two-axis types + `plan-store.ts` validation. **Absent `shellLayout` → "dashboard" (today).** Tests: legacy plans (no field / `layout:"settings"` / `layout:"app-sidebar"`) parse to the correct axes; absent → dashboard. No seam touched yet — pure schema, landable, zero behavior change.

### Stage 2 — `IShellDescriptor` + thread through the seven seams; `dashboard` == today EXACTLY
Add `layout-descriptor.ts` (`getShellDescriptor`, both descriptors) AND wire it through all seams in the SAME stage (no dead-code interim). Every seam resolves `getShellDescriptor(plan.shellLayout ?? "dashboard")`. The `dashboard` path is byte-identical to today (per-seam value-equality regression tests against the current literals). The `app-sidebar` path is new but exercised only when a plan opts in — so landing Stage 2 changes nothing for existing plans (they're dashboard) yet the new path is fully unit-tested.

### Stage 3 — `app-sidebar` end-to-end (behind `shellLayout:"app-sidebar"`)
Nav-set split wiring (code-level above) + app nav-set + its gate-run test + AppShell `navSet` prop + avatar/gear + back-to-app + home default. All gated on `shellLayout==="app-sidebar"`; dashboard untouched. Scope/prompt/testid/e2e/gate all honor `navRole`. Unit + integration tests (split idempotent, resume no-op, knip chain, gate runs the app nav-set test, e2e app-landing helper).

### Stage 4 — Planner emits `shellLayout`
`propose-plan.ts` picks `shellLayout` from the product (default `app-sidebar`; `dashboard` when the product is a dashboard) + per-slice `navRole`. This is what flips NEW apps to the split; stored plans without the field stay dashboard. Planner-contract tests.

### Stage 5 — Tests + live proof of GENERALITY
Per-seam regression (dashboard byte-equal) + split-wiring + schema/migration tests. **Live acceptance across DIFFERENT apps:** (a) a single-entity app, (b) a multi-slice relational app (e.g. Company→Contact→Deal) — several app-role features + a settings-role feature, (c) a `dashboard`-shellLayout app proving the legacy path unchanged. Each: `boringstack done · N/N verified` + final acceptance green, app-area-primary, Settings/Admin intact + reachable via gear, back-to-app works. **Add an e2e for the Settings-area path** (gear → Settings → an account page) so account reachability is gate-covered under the split (v1 missing-test finding).

---

## Critical files
- **New:** `layout-descriptor.ts` (+ tests); nav-set-split wiring fn (mirrors `applyHomeRedirect`).
- **Modify:** `plan-types.ts` + `plan-store.ts` (two axes + migration), `propose-plan.ts` (planner emits axes), `wire-resource.ts` (`wireUiRouteFile` navSet), `build.ts` (`scopeFor` signature + `runBoringstackBuild` split call + home default), `gate.ts` (`FAST_GATE` union keyed on shellLayout), `refine-prompt.ts`, `acceptance/testid-contract.ts`, `acceptance/e2e-generator.ts` (app-landing helper + per-area goto).
- **Reuse:** `homeRouteForPlan`/`wireHomeRedirectForPlan`/`applyHomeRedirect`, existing `AppShell`/`AppSidebar`, `conventions.ts` guides.

## Risks (biggest first; all from the panel)
1. **Backward-compat / default** — absent `shellLayout` MUST behave exactly like today; the split is strictly opt-in. Regression tests assert the dashboard path is byte-identical AND that absent→dashboard (not app-sidebar). No silent default flip.
2. **Fast-gate union (seam #6, false-green)** — the app nav-set test MUST run in `gate.ts` under app-sidebar; test asserts the fast gate runs the union.
3. **Route-area determinism** — chosen by an explicit wire-time `navSet` prop, never runtime URL guessing; no `/dashboard`/`/notifications` collision.
4. **Two-axis migration** — legacy `layout` maps cleanly to `navRole`; existing `settings` slices keep working; tests cover all legacy shapes.
5. **Scope enforcement** — an app feature is denied edits to the account nav-set and vice-versa; scope-violation test.
6. **Resume/ordering** — split + home run plan-level after both pristine captures + infra fail-closed, marker-guarded skip-if-present; never clobbers model-added app-nav entries.
7. **Home** — app-sidebar with no explicit `home` defaults the redirect to the first app-role slice, never `/dashboard`.
8. **Shared React context** — resolved by reusing `AppShell`.

## Verification
- Harness `bun run validate` green; unit + per-seam regression + migration + split-wiring tests pass.
- **Panel-gate every stage's PR via the 4-model `harness-review` (reviewers ok ≥ 2)** — the review of record.
- Live: the three different apps above each reach `N/N verified` + final acceptance green; app-sidebar apps land in the app area (app nav only) with the real account pages reachable via the gear-driven Settings/Admin area (e2e-covered); the dashboard-shellLayout app is byte-unchanged. Generality is the bar — one app passing is necessary, not sufficient.
