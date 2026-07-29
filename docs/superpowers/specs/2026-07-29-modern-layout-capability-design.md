# Modern Layout Capability — Design Spec (Spec 1)

**Status:** approved-by-delegation (user AFK, full decision delegation; decision rule = "best for tsforge + BoringStack"). Panel-gate + live-build validation substitute for user review.

**Goal:** Give the tsforge harness a first-class, general understanding of modern web-app **layouts** and **design-system usage**, so builds produce responsive, accessible, themeable UIs that *lean on* BoringStack's existing primitives, and so an app's **primary UI can live outside the generic "dashboard"** with settings demoted to a secondary area.

**Principle:** Layout + design-system knowledge is a **harness** capability, not a BoringStack change (BoringStack stays minimal). The harness already ships this style of value as front-loaded convention guides + build-time wiring + conditional acceptance; we extend those seams. **Design the model broad** (don't lock into too few layout options); **implement narrow** (ship what the todos app needs, with seams for the rest).

---

## Global Constraints (verbatim, bind every task)

- **Never relax the gate.** No downgrading rules/severity. Fixes make the model satisfy the gate.
- **Core stays stack-agnostic.** All BoringStack-specific logic lives under `packages/core/src/loop/boringstack/`; generic seams only in the core loop.
- **No `as`/`!` casts, no eslint-disable, cc ≤ 20, shared AST walkers.** Run full `bun run validate` before "done".
- **Lean on what exists — do not reinvent.** Compose BoringStack's CSS-variable design tokens + `components/ui/` (ShadCN/Radix) + `data-theme` theming. Author no new CSS framework, no new component library.
- **Responsive + accessible + themeable are defaults, not options**, in every layout the harness emits.
- **Every harness change is panel-gated** (4-model panel, reviewers ok ≥ 2) **and live-build validated** (solo build on a quiet box).

---

## Reality this builds on (from two read-only audits)

**Routing (audit 1):** BoringStack routes are already flat/top-level (`/task`, not `/dashboard/task`). The shell is `AppShell` (sidebar + header) at `apps/ui/src/components/core/AppShell/`. Post-login redirect is `DEFAULT_REDIRECT_TO = "/dashboard"` (`apps/ui/src/features/auth/components/LoginPage/LoginPage.constants.ts`). The harness hardcodes every feature → `ProtectedRoute → AppShell → sidebar entry → nav-testid → sidebar-nav e2e` (`wire-resource.ts` `wireUiRouteFile` ~L133-187 `path:"/${camel}"`; `build.ts` `scopeFor` ~L161-179; `refine-prompt.ts` ~L269; `acceptance/testid-contract.ts` ~L130; `acceptance/e2e-generator.ts` nav test ~L681-686).

**Design system (audit 2):** Tokens in `apps/ui/src/assets/css/tailwind.css` (`:root` + `:root[data-theme="dark"]`, mapped via Tailwind `@theme`): colors `background/foreground/primary(+strong/low/ink/foreground)/secondary/muted(+foreground/strong)/accent(+cyan/pink)/destructive/success/border(+strong)/input/ring/card/panel(+strong)/popover`, `--radius*`, `--font-sans` (Inter) / `--font-mono`, `--animate-*`. Components in `apps/ui/src/components/ui/`: Button, Card, Dialog, DropdownMenu, Form, Input, Label, Popover, ScrollArea, Sheet, Skeleton, Sonner, Switch, Tabs (cva + `cn()` + tailwind-merge + Radix + lucide). Theme via `useTheme()` + `data-theme` attribute (NO `dark:` classes; `AGENT_CONTRACT.md` forbids them). Responsive = mobile-first Tailwind + Sheet drawer (`hidden md:flex` sidebar). A11y = `eslint-plugin-jsx-a11y` 14 rules as ERRORS + Radix + semantic HTML + skip link. Harness `conventions.ts` has 12 topic guides but **nothing on styling/theming/responsive/a11y/composition**.

---

## Part A — Design-system convention guides (codify what exists)

New harness convention topics (front-loaded like the existing 12 in `packages/core/src/loop/conventions.ts`). Pure knowledge; leans 100% on the scaffold. This is the low-risk, high-value half and lands first.

New topics:
1. **`design-tokens`** — the exact token vocabulary + when each applies (primary = CTA, destructive = delete, muted-foreground = secondary text, border/border-strong = dividers, panel/card = containers, ring = focus). Rule: **never hardcode hex/rgb**; use tokens via bare Tailwind classes (`bg-primary`, `text-muted-foreground`). Opacity variants (`border-strong/40`).
2. **`theming`** — theming is `data-theme`-driven; **never use `dark:` variants**; tokens flip automatically. Test both themes by toggling `data-theme`.
3. **`responsive`** — mobile-first (no-prefix = mobile; `md:`/`lg:` = up); the Sheet mobile-drawer pattern for nav; responsive padding idioms (`px-4 lg:px-6`); container queries for intra-component layout.
4. **`accessibility`** — semantic landmarks (`nav`/`main`/`header`/`section`); `aria-label` for icon-only buttons; `aria-hidden` on decorative icons; `sr-only`; `aria-current="page"`; skip link; labels linked to inputs; never make a `div` interactive (use `Button`/links). Frame it as "satisfy the 14 jsx-a11y rules proactively, don't discover them at the gate."
5. **`components-ui`** — prefer `@/components/ui/*` primitives; extend via `cva` variants; compose classes with `cn()` (not ternary/template strings); `asChild` slot pattern; `data-slot` scoping.

Wire these into the topic registry + surface at the same points as existing guides (build refine-prompt + interim `check`/RULE_DOCS).

## Part B — Layout-role capability (the structural change)

**Plan schema (broad).** Extend `IUiIntent` (`packages/core/src/loop/planning/plan-types.ts`):
```ts
layout?: "app-sidebar" | "app-topnav" | "settings" | "focused" | "public"; // default "app-sidebar"
home?: boolean;   // this feature's route is the post-login landing (exactly one per plan)
```
`nav` (existing description) stays. The enum is intentionally broad (anti-lock-in); **v1 implements `app-sidebar` + `settings`**; `app-topnav`/`public`/`focused` are schema-valid and fall back to `app-sidebar`+guidance for now (documented), so the todos app isn't blocked and the vocabulary is future-proof.

**Wiring (implement narrow):** In `packages/core/src/loop/boringstack/`:
- **Sidebar grouping** — the harness's sidebar wiring/guidance groups nav into a **primary app group** (`layout: app-sidebar`) and a demoted **Settings group** (`layout: settings`, plus the scaffold's existing account/profile/notification links). AppSidebar edit stays in feature scope; the refine-prompt tells the model which group to add to based on `layout`.
- **Home landing** — the feature with `home: true` sets `DEFAULT_REDIRECT_TO` to its route. Add `LoginPage.constants.ts` to that feature's scope; the refine-prompt instructs the redirect change. Exactly one home per plan (validated).
- **Route/layout** — keep `ProtectedRoute → AppShell` for `app-sidebar` and `settings` (both are authenticated app areas; "settings" is a grouping + optional sub-nav, not a separate auth boundary in v1). `wireUiRouteFile` stays; only grouping + home differ. (Distinct SettingsLayout / public-unauth shells are **designed-for** via the enum but **deferred** — YAGNI until a build needs them.)

**Acceptance (unchanged contract, role-aware only where safe):** Every feature remains reachable + e2e-tested via its nav testid — `role` only changes *which sidebar group* the nav link lives in, not whether it exists. This deliberately preserves the proven acceptance machinery (no gate relaxation). Smart-view filtering (Spec 2) is verified as UI within the Task feature, not as new entities.

---

## What's implemented now vs designed-for-later

- **Now:** Parts A (all 5 guides) + B (`app-sidebar` + `settings` roles, home landing, sidebar grouping, broad schema).
- **Later (schema-valid, not implemented):** `app-topnav`, `public` (unauth features), `focused` as a distinct feature layout, a dedicated `SettingsLayout` shell. Each is its own future spec when a build needs it.
- **Non-goals:** any BoringStack fork; new CSS/components; M2M relationships; scheduled reminders (Spec 2 Phase 2).

## Testing & validation

- Unit tests for: plan-schema accepts/defaults `layout`/`home`; exactly-one-home validation; sidebar-group selection by role; home→`DEFAULT_REDIRECT_TO` wiring; guides present in the registry.
- **Panel-gate** the harness diff (4-model, ≥2 agree).
- **Live build**: Spec 2 (todos app) is the end-to-end proof — app lands on Today, settings demoted, UI uses tokens/primitives, a11y gate clean. Run solo on a quiet box.

## Architecture / files to change

- `packages/core/src/loop/conventions.ts` — register + author the 5 design-system topics (Part A).
- `packages/core/src/loop/planning/plan-types.ts` — `IUiIntent.layout` + `home` (Part B schema).
- `packages/core/src/loop/boringstack/wire-resource.ts` / `build.ts` / `refine-prompt.ts` — sidebar grouping, home-redirect wiring, `LoginPage.constants` scope (Part B wiring).
- `packages/core/src/loop/boringstack/acceptance/testid-contract.ts` — keep nav contract; document role→group only.
- Plan validation (where `isEntitySpec`/plan is validated) — exactly-one-home + valid `layout`.
- Tests alongside each.
