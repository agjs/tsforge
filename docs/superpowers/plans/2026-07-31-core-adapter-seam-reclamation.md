# Core ↔ Adapter Seam Reclamation — Plan

**Why:** tsforge is a general, TypeScript-specialized, local-model-optimized build harness; BoringStack is its FIRST adapter (Phaser next). Over a month of BoringStack focus, adapter concerns leaked into the core. This plan reclaims a clean seam so the core is stack-agnostic and BoringStack (craft, planning, boilerplate, layout) lives entirely in the adapter. See memory `tsforge-north-star` for the governing laws. **Harness-first, BoringStack-second. Every step panel-gated on the diff. Do not break the working harness.**

## Good news from the audit (branch `feat/app-own-layout`)
The **build-loop seam is already correct**: BoringStack (`runBoringstackBuild`) calls INTO the core `runGreenfield` loop via clean injected interfaces — `IBoringstackHost` (setScope/setGate/setExpertRescueTarget/captureMetaBaseline/send), `IPlanConstraints`, `Exec`, `Session.setGate/setScope`. Core loop has ZERO imports from `loop/boringstack/`. These injection patterns are the MODEL to mirror for every fix below.

## The real leaks (grounded, ranked)
1. **Conventions content in core.** `loop/conventions.ts` is 100% BoringStack (React/Elysia/shadcn/Drizzle) but is core-located and consumed by core: `session.ts:632` (`buildConventionGuides`), `turn.ts:28/229` (`unseenGuidesForErrors` + `PULL_CONVENTIONS_TOOL` offered when `offerConventions`), `tools/pull-conventions.ts` (`conventionGuide`/`conventionTopics`/`isConventionTopic`), and the `PULL_CONVENTIONS_TOOL` topic enum in `agent/agent.constants.ts`. So EVERY build (a future Phaser game) gets React idioms.
2. **Planner constraints in core.** `loop/planning/boringstack-planning.ts` (BoringStack-specific) is core-located; `cli/repl.ts:47-49,184,883` imports `isBoringstackProject`/`boringstackPlanConstraints` directly — core/CLI depending on the adapter.
3. **Web concepts in the core plan schema.** `loop/planning/plan-types.ts`: `IUiIntent` (`screens: list|detail|form|dashboard`, `nav`, `shows`, `layout`, `home`), `LAYOUT_ARCHETYPES`, `IMPLEMENTED_LAYOUT_ARCHETYPES` — all web/BoringStack, sitting in the core plan.
4. Low: BoringStack-only comments in `greenfield/run.ts:244`; `scaffold/boringstack-manifest.ts` naming.

## Workstreams (staged, each independently landable + panel-gated)

### WS1 — Conventions → adapter (via injected provider)
Mirror the `IBoringstackHost`/`cfg`-injection pattern.
- Define a generic `IConventionProvider` in core: `buildGuides(): string`, `unseenForErrors(errors, seen): {topic,guide}[]`, `guide(topic): string | null`, `topics(): string[]`, `isTopic(s): boolean`.
- `ISessionConfig` gains `conventions?: IConventionProvider`. Core consumers read from it: `session.ts:632` → `cfg.conventions?.buildGuides() ?? ""`; `turn.ts` reactive push + tool-offer → `cfg.conventions`; `tools/pull-conventions.ts` → the injected provider (validate topic via `provider.isTopic`); drop/generalize the static topic enum in `agent.constants.ts` (topics come from the provider).
- BoringStack `build-session.ts` constructs the provider from the (relocated) convention library and sets `cfg.conventions`. Absent provider → NO conventions (a generic build gets no React idioms — the whole point).
- **Step A (behavior-preserving):** introduce the provider + injection; BoringStack injects the same guides → identical behavior; generic builds get none. **Step B:** physically move `loop/conventions.ts` → `loop/boringstack/conventions.ts`.
- Keep the `convention-index.test.ts` enum-sync guarantee; update it to the provider.

### WS2 — Planner constraints → adapter
Move `loop/planning/boringstack-planning.ts` → `loop/boringstack/planning.ts`. `cli/repl.ts` must not import it directly — resolve stack detection + `IPlanConstraints` via a small generic seam (a stack-adapter lookup), so the CLI asks "which adapter for this dir?" and the adapter supplies constraints. `proposePlan` already takes generic `IPlanConstraints` — keep that; only the IMPLEMENTATION location + the CLI import move.

### WS3 — Reclaim the plan spine (biggest/riskiest; last)
Core `IProductPlan` keeps the general spine: `product`, the domain model (`IEntitySpec` entities/relations), `IVerificationContract`. The web UI (`IUiIntent` screens/nav/shows/layout/home, `LAYOUT_ARCHETYPES`) moves into a **BoringStack plan-extension** validated by the adapter. Mechanism: the slice carries an adapter-typed `presentation`/`ui` extension the core treats opaquely and the adapter validates (mirrors `IPlanConstraints`' generic-in-core / filled-by-adapter split). `parsePlan`/`plan-store` validation splits into a core spine validator + an adapter validator. This unblocks the layout work cleanly (it becomes an adapter concern that can't touch core). **This supersedes the app-own-layout spec's core placement of `shellLayout` — layout is adapter-only.**

### WS4 — Mechanical boundary (the finish line)
After WS1-3, add a dependency rule (eslint boundaries / dependency-cruiser / custom): **core (`loop/**` except `loop/boringstack/**`, `planning/**` spine, `cli/**`, `agent/**`) MUST NOT import from `loop/boringstack/**`** (and no BoringStack string content in core). A leak becomes a build failure. **This rule passing = the reclamation is done.**

## Finish line
The boundary rule passes + the core plan is a general spine + a generic build (no adapter) carries no BoringStack conventions/UI concepts. Then: core is stack-agnostic, BoringStack lives fully in the adapter, and the deferred layout/craft/planning/boilerplate work all happens inside the adapter — and Phaser later slots in as a second adapter.

## Constraints
Harness-first. Don't break the working BoringStack build (it currently reaches full green). Each WS panel-gated on the diff (4-model `harness-review`, reviewers ok ≥ 2). No full end-to-end builds as the driver — unit tests + panel; a build only as an occasional spot-check when a WS completes.
