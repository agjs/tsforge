# BoringStack full-stack build pivot — design

> **SUPERSEDED (2026-07-15)** by the unified build loop — see `docs/superpowers/specs/2026-07-14-unified-build-loop-design.md`. The implement/evaluate split described below is removed; the real gate now runs inside the loop as a composed `IGate`.

**Date:** 2026-07-12
**Branch:** `feat/self-harness`
**Status:** design — awaiting user review before writing-plans

## Problem

For two-plus days the web-build effort has chased a UI-only React scaffold: the AI
loop scaffolds a throwaway Vite+React app (`scaffoldWeb` → `runWebGreenfield`) with
no backend. Every live build (gfweb1–6) hit the same wall — the model had views but
no data layer, so it faked persistence, and the reject-by-default judge correctly
rejected "no real create/edit, no persistence." gfweb6 proved the pages could be
made kind-appropriate and gate-clean, but also proved the binding constraint is a
real data layer the UI-only path cannot provide.

**Root cause:** the harness was asking the model to *invent architecture* (data
layer, state, CRUD). That degree of freedom is what made every build oscillate.

## Decision

For web apps, **BoringStack is the only thing this harness ever scaffolds.** It is a
production full-stack skeleton (Bun+Elysia API, Vite+React UI, Postgres, Drizzle,
auth/billing, observability) with its own generators, conventions, and gate. We do
**not** force it — a user can still point tsforge at their own greenfield or existing
repo, like any harness. But *our* scaffold = BoringStack, full-stack, real.

This dissolves the entire mock-CRUD problem: persistence is real Postgres from turn
one; the model fills domain logic into generated, gate-clean slices instead of
inventing a data layer.

### What the audits established (facts)

- **tsforge↔BoringStack integration is ~80% built and tested.** `tsforge scaffold
  --archetype boringstack` clones at a pinned ref, reads `.tsforge/scaffold-manifest.json`,
  runs BoringStack's own `rename-project.sh`/`setup.sh`, boots the Docker stack, polls
  health, and composes a real gate: `(cd apps/api && bun run validate) && (cd apps/ui
  && bun run validate) && bun run check`. (`scaffold/{clone,run-scaffold,configure,boot}.ts`,
  fully tested.)
- **BoringStack's per-feature workflow is its own vertical slice:**
  1. `cd apps/api && bun run new:resource -- <Name>` → Drizzle table + Elysia
     routes/service/schemas/types; patches schema/relations/audit.
  2. `bun run db:generate && bun run db:migrate` → real migration.
  3. `bun run regen` (root) → OpenAPI → typed UI client + ACL.
  4. `cd apps/ui && bun run new:feature <Name>` → queries/mutations/Zustand store +
     `<Feature>Page` tree.
  5. `bun run validate` (both apps) + `bun run check`.
  (Exact script names to be confirmed in `apps/api`/`apps/ui` package.json at impl
  time — they are app-level, not root.)
- Backend rule-packs (`elysia`, `drizzle`, `jwt-cookies`, `bullmq`, `authorization`,
  `structured-logging`) and the conventions push/pull system already exist and are wired.
- **The gap:** the AI build loop and the BoringStack scaffold are two unconnected
  paths. The loop never clones BoringStack.

## Scope — three phases

### Phase A — Bank the good work, delete the dead UI-only scaffold

Untangle the uncommitted changes on `feat/self-harness`, keep the general wins, delete
the UI-only scaffold, get green, commit, open a PR, land it.

**KEEP (general, reusable, wanted):**
- Steering ladder — `loop/feedback/steer.ts`, `docs/steering-ladder.md`,
  `loop.constants.ts` (plateau), turn.ts ladder.
- Expert rescue — `loop/expert-handoff.ts`, `expertRescue` flag/config, turn.ts wiring.
- Conventions (BoringStack-aligned) — `loop/conventions.ts`, `loop/tools/pull-conventions.ts`.
- Harness fixes — broken-file deadlock (`tools/file-ops.ts`, `tools/execute-tool.ts`),
  diag-cap (`write-guard.ts`, `session.ts`), `no-self-import` fix, `Session.setScope`.
- Self-harness — `self-harness-campaign.ts`, `self-harness/evaluate.ts`.
- The greenfield ENGINE (`loop/greenfield/{run,evaluate,judge}.ts`) — reused by Phase C.

**DELETE (UI-only scaffold):**
- `src/web-route-views.ts`, `src/lib/web/{web-feature-scope,generate-nav}.ts`,
  `src/loop/greenfield/web-greenfield.ts`, and their tests
  (`web-route-views`, `web-feature-scope`, `generate-nav`, `web-greenfield`).
- Revert UI-only additions in `scripts/headless-build.ts` (the `TSFORGE_GREENFIELD_WEB`
  branch), `loop/greenfield/index.ts` (web exports), `loop/greenfield/plan.ts`
  (`planWebFeatures`/`WEB_SYSTEM`), `loop/greenfield/greenfield.types.ts` (`routes?`).
- **Assess for removal:** `src/gate/web-gate.ts`, `scaffold/web-scaffold.ts`,
  `web-templates.ts`, `loop/tools/scaffold-routes.ts`, and the `vite`/`--web` archetype
  in `repl-scaffold.ts`. These exist only to serve the UI-only path. Remove unless a
  concrete non-UI-only consumer is found. The `astro` archetype stays (it's a real
  BoringStack archetype in the manifest).

**Reconcile (flag for impl):** the `react-component-architecture` conventions/rule-pack
assume `src/views/<Feature>/` layout; real BoringStack UI uses `src/features/<feature>/`
with a generated `<Feature>Page` tree. These must be reconciled with BoringStack's
actual UI conventions (its `apps/ui/docs/agents/*`), not the dead UI-only layout.

**Done = A:** `bun run validate` green (read the real N pass/M fail), UI-only code gone,
PR opened. Merge on explicit user go over the actual diff.

### Phase B — Confirm the BoringStack build seam works end-to-end (manual, no AI)

Before wiring the AI loop, prove the mechanical path by hand on a real clone:
`tsforge scaffold --archetype boringstack` → boot → `new:resource`/`regen`/`new:feature`
for one entity → `validate`. Confirms the generator command names, the exact generated
file set, and that a booted stack + gate works locally. De-risks Phase C.

### Phase C — The full-stack build loop (harness runs generators, model fills domain)

A new driver (sibling to the deleted `runWebGreenfield`, reusing the greenfield engine):

- **Plan:** features = domain resources/entities (not routes).
- **Per feature (`implement`):** the DRIVER deterministically runs BoringStack's
  generators + mechanical wiring (`new:resource`, `db:migrate`, `regen`, `new:feature`,
  route registration), then hands the MODEL the generated slice to fill with real
  domain fields/logic — scoped/frozen per feature via the existing `setScope`.
- **Evaluate:** BoringStack's real gate (`apps/api validate && apps/ui validate &&
  check`) against the running stack (real Postgres) + the reject-by-default judge.
- **Freeze on green**, cycle.
- **Stack boot:** boot only the always-on set (postgres/valkey/api/ui/migrate); skip
  observability/glitchtip for build loops (manifest toggles already support this).

**Done = C:** a live run builds ≥1 real full-stack feature (real API + migration + UI)
that passes BoringStack's own gate, one frozen slice at a time.

## Hard requirement — per-project ISOLATION (naming + ports) (multi-project)

**Compose PROJECT NAME must be dynamic.** Today everything lands under the fixed
project `boringstack-infra` (containers `boringstack-infra-api-dev`, `-ui-dev`, …). A
second scaffolded project would merge into / collide with the same project. The whole
namespace must derive from the user's project name (`<project>-infra-*`). This governs
container names, image names, AND the gate runner's image reference (Task 4's
`GATE_IMAGE` constant is an MVP placeholder — it becomes `<project>-…` under this work).
- `rename:project` takes a `project` param (manifest `renameParams`), but in Phase B the
  scaffold was run WITHOUT a project name, so it stayed `boringstack`/`boringstack-infra`.
  Fix has two parts: (a) tsforge ALWAYS passes a unique per-project name at scaffold time
  (derive from goal/dest); (b) confirm `rename:project` (or `COMPOSE_PROJECT_NAME`) actually
  renames the compose project + image tags, not just source strings.

### Host ports (sub-part of the same isolation work)

BoringStack's compose **hard-codes host ports** (`5432`/`6379`/`7330`/`7331` + observability
`9090`/`9093`/`3010`/`8025`/`1025`/`7332`). Compose *project-name* isolation exists
(`dev.sh` uses `-p boringstack-smoke`) but only namespaces containers/networks/volumes —
NOT host ports. So scaffolding/booting a **second** project collides and forces the user
to "kill everything else." Unacceptable for a harness whose purpose is many projects.

**Fix (joint, first-class for Phase C):**
1. **BoringStack:** env-parameterize compose host ports (`${POSTGRES_PORT:-5432}`, `${API_PORT:-7330}`, …).
2. **tsforge:** on scaffold, allocate a **unique free port block per project** (scan for free
   ports / deterministic offset from project name) and write it into that project's `.env`
   (extends the manifest-driven `.env` writing) + boot under a per-project `-p <name>`.
3. Model the port fields in the scaffold-manifest so tsforge stays stack-agnostic.

Build-loop alternative (either/or): boot with NO published host ports and have the harness
discover the mapped port via `docker compose -p <proj> port api 7330` for `generate:api` +
browser smoke. Until this lands, the harness must boot **one project at a time** and either
reuse or tear down between builds (and `log()` that it did).

## Risks

- **Docker boot weight** for the eval loop — mitigate via minimal service set.
- **Local model driving shell sequences is fragile** — mitigated by the harness (not
  the model) running the mechanical generator steps.
- **Generator command names / generated file set** — verified in Phase B before C.
- **Conventions/rule-pack drift** from real BoringStack UI layout — reconciled in Phase A.

## Non-goals

- Forcing BoringStack on users who bring their own repo.
- The hosted "SaaS builder" control-plane (`.cursor/plans/tsforge_saas_builder`) — that
  is a separate product; this pivot is the local build loop it would later wrap.
- Keeping any UI-only scaffold as a maintained path.
