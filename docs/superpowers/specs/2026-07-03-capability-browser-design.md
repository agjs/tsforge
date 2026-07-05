# In-harness capability browser (feature discoverability)

**Status:** design, awaiting review
**Date:** 2026-07-03
**Branch (proposed):** `feat/capability-browser`

## Problem

tsforge has accumulated many capabilities that the harness never advertises, so
users — including the author — forget they exist:

- **Whole features live outside the interactive surface.** `tsforge scaffold`
  (greenfield wizard → **boringstack** full stack or **astro** static site) and
  `tsforge run <recipe>` (declarative recipes) are shell subcommands only. A user
  in the REPL gets no hint they exist, and the astro-vs-boringstack choice is
  invisible.
- **Powerful capabilities run invisibly.** scout, `git_context`, web research, the
  `script` tool, memory learning, TTSR, write-diagnostics are all active but the
  user never learns them or sees them fire.
- **Options within a feature are hidden.** e.g. archetype selection during scaffold.

The 17 slash commands ARE listed (`/help` text + the `/` palette). The gap is the
three classes above.

Root cause: features have been added without any obligation to give them a
discovery home. Docs drift; the TUI never learns about the feature at all.

## Goals

1. A **pull-based, in-session capability browser** — the user opens it and browses
   everything the harness can do, grouped, each with a one-line description.
2. **Actionable:** selecting a command runs it (or prefills its args); selecting a
   wizard (scaffold) opens it **in the REPL**; selecting a passive capability shows
   a short explainer.
3. **Bring the scaffold flow into the session** — archetype pick
   (boringstack / astro / vite) + config, driven in-REPL, not shell-only.
4. **Make it structurally impossible to ship an undiscoverable feature** via an
   anti-drift test over a single capability registry.

## Non-goals (deferred to later specs)

- Proactive/contextual surfacing (empty-dir → "scaffold?"). Separate spec.
- "Make the invisible visible" run-time annotations (scout fired, memory recalled).
- First-run onboarding tour.
- Auto-generating a docs page from the registry (nice follow-up; the drift test is
  the priority here).

## Design

### 1. Capability registry — single source of truth

A pure, injected registry mirroring the existing `ISetting` registry
(`src/cli/config-menu.ts`) and mode registry (`src/cli/modes.ts`).

```ts
// src/cli/capabilities.ts
export type CapabilityKind = "command" | "wizard" | "passive";

export interface ICapability {
  readonly id: string;         // stable slug, e.g. "scaffold", "map", "tool.scout"
  readonly group: string;      // display group (see §2)
  readonly label: string;      // short name shown in the row
  readonly describe: string;   // one-line in-TUI docs (REQUIRED, non-empty)
  readonly kind: CapabilityKind;
  /** Longer explainer shown when a `passive` row is selected (what it does + when
   *  it fires). Optional for command/wizard rows. */
  readonly detail?: string;
  /** How the browser activates this row. For "command": the slash command to run
   *  or prefill. For "wizard": an opener key the host maps to a wizard launcher.
   *  For "passive": undefined (selection shows `detail`). */
  readonly invoke?:
    | { readonly type: "run"; readonly command: string }        // run immediately
    | { readonly type: "prefill"; readonly command: string }    // e.g. "/gate "
    | { readonly type: "wizard"; readonly opener: string };     // e.g. "scaffold"
}

export function buildCapabilities(deps: ICapabilityDeps): ICapability[];
```

`buildCapabilities` is pure and unit-testable (no I/O); the host injects the
openers/runners via `ICapabilityDeps` (same dependency-injection style as
`IConfigDeps`).

### 2. `/help` becomes the browser

`/help` stops printing static text and renders the grouped, actionable browser,
**reusing the `/config` owned-stdin menu driver** (`runConfigMenu`'s pattern in
`src/cli/config-menu.ts`): grouped rows, per-row dim `describe`, ↑/↓ nav, Enter,
Esc, and the editor `inert` gate added for `/config`. We extract the shared driver
so both `/config` and `/help` use it (no copy-paste).

Groups and rows (each row = an `ICapability`):

- **Build something new** — Scaffold a project *(wizard)* · Run a recipe *(wizard —
  opens an in-REPL recipe picker; there is no `/run` slash command today, recipes
  are the shell `tsforge run`)*
- **Understand your code** — Map workspace (`/map`) · Review changes (`/review`)
- **Steer the session** — Plan (`/plan`) · Gate (`/gate`) · Scope (`/files`) ·
  Model (`/model`) · Settings (`/config`) · Conventions (`/setup`)
- **Session & cost** — Sessions · Compact · Clear · Cost · Metrics · Trace · Memory
- **The model's tools (always on)** — Scout · git context · web research · script ·
  TTSR · write diagnostics · memory learning *(all `passive` — Enter shows `detail`)*

Selection behavior by kind:
- `command` + `invoke.run` → close the browser, run the slash command via the
  existing dispatch (`runLine`/`command`).
- `command` + `invoke.prefill` → close, prefill the input row (reuse the palette's
  `takesArg` prefill path) so the user types the argument.
- `wizard` → close the browser, open the wizard in-REPL (see §3).
- `passive` → render the `detail` explainer in place (a sub-view; Esc returns to the
  list). Nothing to run.

### 3. Scaffold wizard in the REPL

Selecting "Scaffold a project" opens a wizard **in-session** (not the shell
subcommand), reusing `src/scaffold` + the generic wizard (`src/render/wizard.ts`),
the same way `/setup` runs its wizard in-REPL:

1. **Archetype step** — single-select: `boringstack` (full Bun+Elysia+Drizzle+Vite/
   React), `astro` (static site), `vite` (React web skeleton, today's `--web`).
2. **Config step(s)** — the existing scaffold config surface (manifest-driven for
   boringstack/astro; `scaffold.types.ts` `IArchetype`/manifest), collected via the
   generic wizard's text/single/multi steps.
3. On finish, run the existing scaffold path (`src/scaffold/clone.ts` +
   configure) exactly as the shell subcommand does, then hand back to the REPL.

Wizards launched from the REPL must pass `manageInput: false` and run under the
`inert` editor gate (both already exist) so they don't fight the editor for stdin.

### 4. `/` palette stays the fast runner

Unchanged as the fuzzy quick-runner for known commands. Optionally add a scaffold
and a recipe launcher entry so power users can quick-launch them; `/help` remains
the place to *discover*.

### 5. Anti-drift test (the keystone)

A unit test that fails when a feature ships without a discovery home:

- Every entry in `COMMAND_SPECS` (`src/cli/commands.ts`) has a matching
  `ICapability` (by the command name).
- Every value in `TOOL_NAME` (`src/agent/agent.constants.ts`) has a matching
  `passive` (or otherwise-classified) `ICapability`.
- Every `ICapability.describe` is non-empty; every non-passive has a valid `invoke`.
- The scaffold archetypes in `scaffold.types.ts` (`IArchetype`) are all reachable
  from the scaffold wizard's archetype step.

This is what prevents the discoverability rot from recurring.

## Architecture / reuse (no new frameworks)

- **Driver:** extract the owned-stdin grouped-menu loop from `config-menu.ts`
  (`runConfigMenu`) into a shared `render/owned-menu.ts` (or keep in place and
  parameterize) used by both `/config` and `/help`. Same key handling, `inert`
  gate, alt-screen, per-row `describe`.
- **Wizard:** `src/render/wizard.ts` (`runWizard`, `manageInput`) — already used by
  `/setup`.
- **Scaffold:** `src/scaffold/*` — already exists; we add an in-REPL launcher.
- **Registry:** new `src/cli/capabilities.ts`, injected like `IConfigDeps`.

## Testing

1. **Unit — registry completeness / anti-drift** (§5). The keystone; ranks first.
2. **Unit — `buildCapabilities`** against fake deps: every capability has group/
   label/non-empty describe/valid kind+invoke; passive rows carry `detail`.
3. **Real-PTY e2e** (`scripts/e2e-*-pty.py`, the definition-of-done per house
   practice): open `/help`, assert groups + per-row descriptions render; select a
   passive row → explainer shows; select a command → it runs; select "Scaffold" →
   the archetype wizard opens (boringstack/astro/vite visible); Esc closes without
   quitting; the editor works again afterward (inert gate cleared) and its input is
   not doubled.

## Rollout

Single PR on `feat/capability-browser`. `bun run validate` green (typecheck + lint +
format + unit + all PTY suites). Update docs: `cli/interactive.mdx` (/help is now a
browser), a short note in the relevant pages that scaffold/recipes are reachable
from `/help`.

## Open questions

- Recipe row: open an in-REPL recipe picker (reuse the menu driver over the named
  recipe set), then run the chosen recipe via the existing `tsforge run` path.
  Whether to also add a `/run <name>` slash command is optional and low-risk —
  resolve during implementation.
