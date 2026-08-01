# Scaffold ANY app in its OWN layout (BoringStack demo dashboard becomes disposable) — Design Spec v3

**Status:** approved by the user (2026-07-31), approach (A) chosen. v1 + v2 were BLOCKED by the tsforge 4-model panel. v3 switches to an **additive** architecture that resolves the blocking findings by construction (real scope enforcement, the demo shell + its 11 routes untouched, the `dashboard` path literally unchanged, no per-slice nav-role axis). Re-submitted to the panel for the review of record before implementation.

## Context

The harness already builds arbitrary **domain features**, but force-wraps every one into BoringStack's demo `AppShell` + shared `AppSidebar` (a closed-typed, single-file structure) through several hardcoded coupling points. So every app comes out as links bolted onto the showcase dashboard. The dashboard is a **disposable showcase**, not the frame. Ground truth (verified against the scaffold): the shared `AppSidebar` uses a closed `IAppSidebarNavId` union + a typed icon `Record` + a count-assertion test; `routes.tsx` has **11** hardcoded `<AppShell>` wrappers; features are injected today as entries in the `APP_SIDEBAR_NAV_ITEMS` constant. v1/v2 tried to *split that shared file in-place* and the panel correctly showed it can't be scope-enforced or kept backward-compatible.

**Confirmed with the user:** keep the real account pages (billing/MFA/OAuth/team/audit/notifications) — they become the **Settings/Admin area**; nothing deleted. The requested app is primary, in its own layout, where you land. Deliver the general mechanism; prove it on several different apps.

## Approach (A): additive app nav — the demo shell/routes stay as Settings

For `shellLayout: "app-sidebar"` the harness gives the app its **own nav-set (as DATA in a new file)** and has the shared `AppSidebar`/`AppShell` render it, plus cross-navigation links between the app and the Settings area. The scaffold's **9 account/dashboard route wrappers, `APP_SIDEBAR_NAV_ITEMS`, `IAppSidebarNavId`, and the existing sidebar test are left exactly as-is** — they ARE the Settings/Admin area. The shared `AppSidebar`/`AppShell` **components** gain small additive, backward-compatible changes (below). Why (A) beats v2's in-place split:
- **Real scope enforcement** — the app nav *items* live in a NEW file (`APP_NAV_ITEMS`) at a distinct path; path-glob scope denies app features the account `AppSidebar`/`APP_SIDEBAR_NAV_ITEMS`. (v2's critical is gone: separate files, not two arrays in one.)
- **`dashboard`/legacy path = behaviorally unchanged** — when `shellLayout` is absent/`"dashboard"`, the harness emits nothing new and features go into the existing `APP_SIDEBAR_NAV_ITEMS` exactly as today; the new component props default to today's render. (Honest scope: the scaffold `AppSidebar`/`AppShell` *source* gains optional props/one conditional — a one-time template change, defaulted — so it is "behaviorally identical for dashboard builds," NOT "byte-identical scaffold source." The generated per-feature output for a dashboard build is unchanged.)
- **No per-slice nav-role** — the Settings area is the pre-existing scaffold pages, not plan features, so every plan slice is an app feature; the `navRole` axis is dropped.

### One axis only
- **`IProductPlan.shellLayout?: "dashboard" | "app-sidebar"`** — absent → `"dashboard"` = today's behavior. The **planner emits it**. Legacy `IUiIntent.layout` keeps its current meaning **only on the dashboard path**, so legacy `layout:"settings"` demotion still works exactly as today.
- **Validation:** an `app-sidebar` plan MUST have ≥ 1 slice (`plan-store.ts` rule); `isProductPlan` currently allows `slices:[]`, so this closes the "empty plan → no app home" hole below. `gate.ts` and every consumer read the **normalized/defaulted** plan from `plan-store` (never the raw file), so an absent `shellLayout` is always seen as `"dashboard"` (no false-green from `undefined`).

### Nav as DATA + additive, backward-compatible shell changes
The real `AppShell` mounts `AppSidebar` twice (desktop `<AppSidebar/>` + mobile `<AppSidebar onNavigate={closeMobileNav} className="w-full"/>`), so an opaque element prop can't carry per-mount props. Instead pass **data**:
- **`AppSidebar` gains optional props (all defaulted to today):** `navItems?` (default = today's account items from `APP_SIDEBAR_NAV_ITEMS`) rendered in BOTH mounts; and a `footerLink?: {to,label}` slot. No props → renders exactly as today (the backward-compat guarantee; test both mounts render identically with no props). Feature pages keep `AppShell`'s providers/header (`AppPageHeaderProvider`, `AccountSwitcher`, `NotificationBell`, `ThemeToggle`, sign-out) — no second provider tree, no context loss.
- **App route wrapper:** `<ProtectedRoute><AppShell brandTo={appHome}><AppSidebar navItems={APP_NAV_ITEMS} footerLink={settings→/account/profile} …/></AppShell>` (rendered internally in both mounts) — the app sidebar shows the app's features + a **Settings** footer link, so Settings is reachable (fixing the "app→Settings unreachable" critical: the stock header has no settings link).
- **`APP_NAV_ITEMS`** is a NEW open-typed data file (`{id,path,labelKey}[]`, no closed union) features append to; ships with its own co-located count test.

### Settings → app (the single additive component change, not a wrapper edit)
`AppSidebar`, when rendering the **default** (account) nav AND an app area exists (`APP_NAV_ITEMS` non-empty), shows a **"← back to app"** footer link → the app home. This is ONE additive, conditional change to the shared `AppSidebar` component (empty app nav → no link → today's render), so the 9 account route **wrappers stay untouched** and the dashboard path is unaffected. (The desktop brand is a non-link `<span>` today; back-to-app is a real nav link in the sidebar footer, not the brand.)

### Home (never lands in Settings)
`wireHomeRedirectForPlan` sets `DEFAULT_REDIRECT_TO`. Under `app-sidebar`: the `home` slice's route if marked, else the **first slice's route** (stable plan order). Combined with the ≥1-slice validation rule above, there is always an app landing — the v2 "lands in /dashboard" holes cannot occur.

### Decision-making (no new agent tools)
Planner picks `shellLayout` (user-approves the plan). Harness applies it deterministically (generate `AppNav` + shell props + wrapper + gate + home). The build agent gets **no new tools / no layout discretion** — under `app-sidebar` it just appends its link to the app-nav file the harness scoped + named; under `dashboard` it does exactly what it does today.

### `IShellDescriptor` (keyed by shellLayout, plan-level)
```ts
type ShellLayout = "dashboard" | "app-sidebar";
interface IShellDescriptor {
  wrapRoute: (pageJsx: string, ctx: { brandTo: string }) => string; // route element for a feature page
  navFile: string;              // file a feature appends its nav link to (APP_NAV_ITEMS vs existing constants)
  navGuidance: string;          // refine-prompt text for where/how to add the link
  navTestId: (camel: string) => string;
  sidebarTestGlobs: string[];   // union the fast gate runs (account test always; APP_NAV_ITEMS test under app-sidebar)
  emitsAppNav: boolean;         // app-sidebar=true (harness seeds APP_NAV_ITEMS + passes navItems/footerLink); dashboard=false (today)
}
export function getShellDescriptor(shell: ShellLayout): IShellDescriptor // throws on unknown; only 2 today
```
Honest scope note: covers `{dashboard, app-sidebar}` only. `public`/`focused`/`top-nav` need more fields (auth boundary, provisioning) — explicit future extension points, not claimed-covered.

## Stages (each additive, landable, no dead code, no default-flip)

### Stage 1 — `shellLayout` schema + validation (zero behavior change)
Add `IProductPlan.shellLayout` + `plan-store.ts` validation; absent → `"dashboard"`. Legacy `layout` untouched. Planner NOT yet emitting it → every build stays dashboard. Tests: absent→dashboard; explicit values parse; legacy plans unaffected. Landable, no behavior change.

### Stage 2 — `app-sidebar` end-to-end behind the flag (additive)
`IShellDescriptor` + `getShellDescriptor`; `AppSidebar` optional `navItems`/`footerLink` props (rendered in BOTH desktop + mobile mounts; defaults = today's account items) + conditional "← back to app" footer when an app area exists; `AppShell` optional `brandTo`; the `APP_NAV_ITEMS` open-typed data file + its count test; `wireUiRouteFile` branches on the descriptor (app-sidebar → `AppShell brandTo` wrapping `AppSidebar navItems/footerLink`; dashboard → today's literal, unchanged); `scopeFor(name, shellLayout)` grants the `APP_NAV_ITEMS` file + its test under app-sidebar (not the account sidebar); `refine-prompt` app-nav guidance; `gate.ts` runs the sidebar-test union keyed on the normalized `plan.shellLayout`; `e2e-generator` app-area landing helper (both cross-nav directions); `wireHomeRedirectForPlan` first-slice default; the marker-guarded `APP_NAV_ITEMS` seeding + home wiring (plan-level, after pristine baselines + `captureMetaBaseline` + infra fail-closed, skip-if-present, resume-safe per file). Exercised by unit tests + a test plan with `shellLayout:"app-sidebar"`. The `dashboard` path is behaviorally unchanged. Landable: dashboard unchanged, app-sidebar fully working + tested, opt-in only.

### Stage 3 — Planner emits `shellLayout`
`propose-plan.ts` picks `app-sidebar` for normal apps, `dashboard` only for dashboard-shaped products (heuristic: the product's primary purpose is viewing aggregate/overview data with no primary CRUD entity → dashboard; otherwise app-sidebar; default app-sidebar). This flips NEW apps to their own layout; stored plans (no field) stay dashboard. Planner-contract tests.

### Stage 4 — Tests + live proof of GENERALITY
Per-seam tests (both descriptors) + generation/idempotency/resume + gate-union + home-default + scope-denial (real: app feature can't edit account sidebar). **Live across DIFFERENT apps:** (a) single-entity app, (b) multi-slice relational app (Company→Contact→Deal), (c) a `dashboard`-shellLayout app (legacy path unchanged). Each: `boringstack done · N/N verified` + final acceptance green; app-sidebar apps land in the app area with the real account pages reachable via the gear (e2e-covered) + back-to-app working; dashboard app byte-unchanged.

## Critical files
- **New:** `layout-descriptor.ts` (+tests); the `APP_NAV_ITEMS` open-typed data file (harness template) + its co-located count test; nav/home generation wiring (mirrors `applyHomeRedirect`).
- **Modify (harness):** `plan-types.ts`/`plan-store.ts` (shellLayout + ≥1-slice-under-app-sidebar rule + normalized read), `propose-plan.ts` (planner emits it), `wire-resource.ts` (`wireUiRouteFile` descriptor branch), `build.ts` (`scopeFor` signature + `runBoringstackBuild` generation/home), `gate.ts` (test-glob union keyed on the NORMALIZED shellLayout), `refine-prompt.ts`, `acceptance/testid-contract.ts`, `acceptance/e2e-generator.ts` (app-area helper).
- **Modify (scaffold, additive + backward-compatible):** `AppSidebar` gains optional `navItems`/`footerLink` (defaults = today's account items) rendered in BOTH desktop + mobile mounts, and a conditional "← back to app" footer when an app area exists; `AppShell` gains an optional `brandTo`. No props → identical to today. This is a one-time template change to the shared components (behaviorally identical for dashboard builds).
- **Untouched:** the **9** existing `<AppShell>` route wrappers, `APP_SIDEBAR_NAV_ITEMS`, `IAppSidebarNavId`, the existing sidebar test — the Settings area.
- **Reuse:** `homeRouteForPlan`/`wireHomeRedirectForPlan`/`applyHomeRedirect`, `AppShell` providers/header, `conventions.ts` guides.

## Risks (biggest first)
1. **Backward-compat** — absent/`dashboard` must be behaviorally unchanged; features → existing constants, and the new `AppSidebar`/`AppShell` props default to today's render. Test: both sidebar mounts render identically with no props; a dashboard build's generated feature output is unchanged.
2. **Fast-gate union (false-green)** — under app-sidebar the `APP_NAV_ITEMS` test MUST run in `gate.ts` (union with the account sidebar test), keyed on the normalized shellLayout; test asserts it does.
3. **Scope denial is now real** — app-nav data is a separate file; test that an app feature editing the account `AppSidebar`/`APP_SIDEBAR_NAV_ITEMS` is out-of-scope.
4. **Cross-nav reachability** — app→Settings via the app sidebar's Settings footer link; Settings→app via the conditional back-to-app footer. e2e covers both directions (the stock header has no settings link, so this must be explicit).
5. **Resume/ordering** — generation + home run plan-level after both pristine captures + infra fail-closed, marker-guarded, skip-if-present per file; a partial run re-completes on resume without clobbering model-added `APP_NAV_ITEMS` entries.
6. **Twice-mounted sidebar** — `navItems` is data (not an element), so both desktop and mobile mounts render the app nav + close-on-navigate works; test the mobile mount.
7. **Accepted parity-with-today (NOT regressions):** (a) a feature could rewrite a sibling's `APP_NAV_ITEMS` entry — identical add-only-shared-file discipline as today's `APP_SIDEBAR_NAV_ITEMS`; (b) the feature's scope includes its own nav count-test so it can bump the count — exactly as the existing flow scopes `AppSidebar.test.tsx` today. Both are pre-existing harness properties, not introduced here; noted, not fixed in this spec.
8. **Planner heuristic** — a wrong dashboard/app-sidebar guess is visible in the user-approved plan (human backstop); defaults to app-sidebar.

## Verification
- `bun run validate` green; unit + regression + generation + scope-denial + gate-union tests pass.
- **Panel-gate every stage's PR via the 4-model `harness-review` (reviewers ok ≥ 2)** — review of record.
- Live: the three different apps reach `N/N verified` + final acceptance green; app-sidebar apps land in their own app area with the real account pages reachable via the gear (e2e) + back-to-app; the dashboard app is byte-unchanged. Generality is the bar — one app passing is necessary, not sufficient.
