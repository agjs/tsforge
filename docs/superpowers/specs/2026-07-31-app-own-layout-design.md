# Scaffold ANY app in its OWN layout (BoringStack demo dashboard becomes disposable) — Design Spec v3

**Status:** approved by the user (2026-07-31), approach (A) chosen. v1 + v2 were BLOCKED by the tsforge 4-model panel. v3 switches to an **additive** architecture that resolves the blocking findings by construction (real scope enforcement, the demo shell + its 11 routes untouched, the `dashboard` path literally unchanged, no per-slice nav-role axis). Re-submitted to the panel for the review of record before implementation.

## Context

The harness already builds arbitrary **domain features**, but force-wraps every one into BoringStack's demo `AppShell` + shared `AppSidebar` (a closed-typed, single-file structure) through several hardcoded coupling points. So every app comes out as links bolted onto the showcase dashboard. The dashboard is a **disposable showcase**, not the frame. Ground truth (verified against the scaffold): the shared `AppSidebar` uses a closed `IAppSidebarNavId` union + a typed icon `Record` + a count-assertion test; `routes.tsx` has **11** hardcoded `<AppShell>` wrappers; features are injected today as entries in the `APP_SIDEBAR_NAV_ITEMS` constant. v1/v2 tried to *split that shared file in-place* and the panel correctly showed it can't be scope-enforced or kept backward-compatible.

**Confirmed with the user:** keep the real account pages (billing/MFA/OAuth/team/audit/notifications) — they become the **Settings/Admin area**; nothing deleted. The requested app is primary, in its own layout, where you land. Deliver the general mechanism; prove it on several different apps.

## Approach (A): additive app shell — the demo shell stays untouched as Settings

For `shellLayout: "app-sidebar"` the harness **generates a new app shell + its own nav file** and wraps the plan's feature routes in it. The scaffold's existing `AppShell`, `AppSidebar`, `APP_SIDEBAR_NAV_ITEMS`, its test, and all **11 account/dashboard route wrappers are left exactly as-is** — they ARE the Settings/Admin area. This is why (A) beats the v2 in-place split:
- **Real scope enforcement** — app features edit a NEW app-nav file at a distinct path; path-glob scope denies them the account `AppSidebar` (the v2 critical is gone — separate files, not two arrays in one).
- **`dashboard`/legacy = literally unchanged** — when `shellLayout` is absent/`"dashboard"`, nothing new is emitted and features go into the existing `APP_SIDEBAR_NAV_ITEMS` exactly as today. No navSet prop on the 11 wrappers, no closed-type edits, no count-test churn. Byte-unchanged, not merely value-equal.
- **No per-slice nav-role** — the Settings area is the pre-existing scaffold pages, not plan features, so every plan slice is an app feature. The whole `navRole` axis (and its "how do we classify settings-role" problem) is dropped.

### One axis only
- **`IProductPlan.shellLayout?: "dashboard" | "app-sidebar"`** — absent → `"dashboard"` = today's exact behavior. The **planner emits it** (`app-sidebar` for normal apps; `dashboard` only when the product itself is a dashboard) so new apps get their own layout while stored/legacy plans rebuild identically. Legacy `IUiIntent.layout` stays readable and keeps its current meaning **only on the dashboard path** (nav placement in the one sidebar) — untouched, so legacy `layout:"settings"` demotion still works exactly as today.

### The generated app shell (reuse, don't duplicate; minimal, backward-compatible touch)
- **`AppShell` gains two OPTIONAL, defaulted props** — `sidebar?: ReactNode` (default: today's `<AppSidebar/>`) and `brandTo?: string` (default: `"/dashboard"`). The 11 account wrappers pass neither → **rendered identically to today** (this is the whole backward-compat guarantee; a defaulted optional prop is not a rewrite). This reuses ALL of `AppShell`'s providers/header (`AppPageHeaderProvider`, `AccountSwitcher`, `NotificationBell`, `ThemeToggle`, sign-out) so feature pages that call `useAppPageHeader` keep working — no context re-provisioning, no second provider tree, no import collision.
- App feature routes wrap in `<ProtectedRoute><AppShell sidebar={<AppNav/>} brandTo={home}>` — same shell, app nav-set, brand → the app home (so the app chrome never yanks you to `/dashboard`).
- **`AppNav`** is a NEW generated component + an **open-typed** nav file (`APP_NAV_ITEMS`, plain `{id,path,labelKey}[]`, no closed union, its own icon handling) that features append to. It ships with its own co-located count test at a known path.

### Settings ↔ app cross-navigation (the single account-side touch)
Under `app-sidebar`, one deterministic, marker-guarded edit to the account side: set the account `AppShell`'s `brandTo` default usage so the Settings area has a **"← back to app"** affordance pointing at the app home (either via `brandTo` on the account wrappers or a small back link injected once). The app side reaches Settings via the existing header avatar/gear → `/account/profile`. Both directions are harness-wired, not model-authored.

### Home (never lands in Settings)
`wireHomeRedirectForPlan` sets `DEFAULT_REDIRECT_TO`. Under `app-sidebar`: the `home` slice's route if marked, else the **first feature slice's route** (stable plan order). A plan always has ≥1 feature slice, so there is always an app landing — the "zero app-role slices" / "lands in /dashboard" holes from v2 cannot occur (no navRole; all slices are app features).

### Decision-making (no new agent tools)
Planner picks `shellLayout` (user-approves the plan). Harness applies it deterministically (generate `AppNav` + shell props + wrapper + gate + home). The build agent gets **no new tools / no layout discretion** — under `app-sidebar` it just appends its link to the app-nav file the harness scoped + named; under `dashboard` it does exactly what it does today.

### `IShellDescriptor` (keyed by shellLayout, plan-level)
```ts
type ShellLayout = "dashboard" | "app-sidebar";
interface IShellDescriptor {
  wrapRoute: (pageJsx: string, ctx: { brandTo: string }) => string; // route element for a feature page
  navFile: string;              // file a feature appends its nav link to (app-nav vs existing constants)
  navGuidance: string;          // refine-prompt text for where/how to add the link
  navTestId: (camel: string) => string;
  sidebarTestGlobs: string[];   // union the fast gate runs (account test always; app-nav test under app-sidebar)
  generatesShell: boolean;      // app-sidebar=true (emit AppNav + shell props); dashboard=false (today)
}
export function getShellDescriptor(shell: ShellLayout): IShellDescriptor // throws on unknown; only 2 today
```
Honest scope note: covers `{dashboard, app-sidebar}` only. `public`/`focused`/`top-nav` need more fields (auth boundary, provisioning) — explicit future extension points, not claimed-covered.

## Stages (each additive, landable, no dead code, no default-flip)

### Stage 1 — `shellLayout` schema + validation (zero behavior change)
Add `IProductPlan.shellLayout` + `plan-store.ts` validation; absent → `"dashboard"`. Legacy `layout` untouched. Planner NOT yet emitting it → every build stays dashboard. Tests: absent→dashboard; explicit values parse; legacy plans unaffected. Landable, no behavior change.

### Stage 2 — `app-sidebar` end-to-end behind the flag (additive)
`IShellDescriptor` + `getShellDescriptor`; the `AppShell` optional `sidebar`/`brandTo` props (defaults preserve today); generated `AppNav` + open-typed nav file + its count test; `wireUiRouteFile` branches on the descriptor (app-sidebar → `AppShell sidebar/brandTo`; dashboard → today's literal, unchanged); `scopeFor(name, shellLayout)` grants the app-nav file + its test under app-sidebar (not the account sidebar); `refine-prompt` app-nav guidance; `gate.ts` runs the sidebar-test union keyed on `plan.shellLayout`; `e2e-generator` app-area landing helper; `wireHomeRedirectForPlan` first-feature default; the marker-guarded generation + back-to-app wiring (plan-level, after pristine baselines + `captureMetaBaseline` + infra fail-closed, skip-if-present, resume-safe per file). Exercised by unit tests + a test plan with `shellLayout:"app-sidebar"`. The `dashboard` path is literally untouched. Landable: dashboard unchanged, app-sidebar fully working + tested, opt-in only.

### Stage 3 — Planner emits `shellLayout`
`propose-plan.ts` picks `app-sidebar` for normal apps, `dashboard` only for dashboard-shaped products (heuristic: the product's primary purpose is viewing aggregate/overview data with no primary CRUD entity → dashboard; otherwise app-sidebar; default app-sidebar). This flips NEW apps to their own layout; stored plans (no field) stay dashboard. Planner-contract tests.

### Stage 4 — Tests + live proof of GENERALITY
Per-seam tests (both descriptors) + generation/idempotency/resume + gate-union + home-default + scope-denial (real: app feature can't edit account sidebar). **Live across DIFFERENT apps:** (a) single-entity app, (b) multi-slice relational app (Company→Contact→Deal), (c) a `dashboard`-shellLayout app (legacy path unchanged). Each: `boringstack done · N/N verified` + final acceptance green; app-sidebar apps land in the app area with the real account pages reachable via the gear (e2e-covered) + back-to-app working; dashboard app byte-unchanged.

## Critical files
- **New:** `layout-descriptor.ts` (+tests); generated `AppNav` component + open-typed nav file + its test (templates in the harness); nav-set/shell generation wiring (mirrors `applyHomeRedirect`).
- **Modify:** `plan-types.ts`/`plan-store.ts` (shellLayout), `propose-plan.ts` (planner emits it), `wire-resource.ts` (`wireUiRouteFile` descriptor branch), `build.ts` (`scopeFor` signature + `runBoringstackBuild` generation/home), `gate.ts` (test-glob union keyed on shellLayout), `refine-prompt.ts`, `acceptance/testid-contract.ts`, `acceptance/e2e-generator.ts` (app-area helper). Scaffold side: `AppShell` gains optional `sidebar`/`brandTo` (defaults = today) — the ONLY change to existing shell code, backward-compatible.
- **Untouched:** the 11 existing `<AppShell>` route wrappers, `AppSidebar`, `APP_SIDEBAR_NAV_ITEMS`, `IAppSidebarNavId`, the existing sidebar test — all stay as the Settings area.
- **Reuse:** `homeRouteForPlan`/`wireHomeRedirectForPlan`/`applyHomeRedirect`, `AppShell` providers/header, `conventions.ts` guides.

## Risks (biggest first)
1. **Backward-compat** — absent/`dashboard` must be byte-unchanged; guaranteed by construction (nothing new emitted; features → existing constants) + regression tests. The `AppShell` optional props must default to today's render (test the account wrappers render identically with no props).
2. **Fast-gate union (false-green)** — under app-sidebar the app-nav test MUST run in `gate.ts`; test asserts it does; the account test still runs.
3. **Scope denial is now real** — app-nav is a separate file; test that an app feature editing the account `AppSidebar` is out-of-scope.
4. **Generated shell reuses providers** — `AppShell` with the `sidebar` prop keeps `AppPageHeaderProvider` etc.; feature pages using `useAppPageHeader` still work (same shell instance).
5. **Resume/ordering** — generation + home + back-to-app run plan-level after both pristine captures + infra fail-closed, marker-guarded, skip-if-present per file; a partial run re-completes on resume without clobbering model-added app-nav entries.
6. **Planner heuristic** — a wrong dashboard/app-sidebar guess is visible in the user-approved plan (human backstop) and defaults to app-sidebar.

## Verification
- `bun run validate` green; unit + regression + generation + scope-denial + gate-union tests pass.
- **Panel-gate every stage's PR via the 4-model `harness-review` (reviewers ok ≥ 2)** — review of record.
- Live: the three different apps reach `N/N verified` + final acceptance green; app-sidebar apps land in their own app area with the real account pages reachable via the gear (e2e) + back-to-app; the dashboard app is byte-unchanged. Generality is the bar — one app passing is necessary, not sufficient.
