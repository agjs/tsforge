# In-harness config UX — design

## Context

tsforge has accumulated a large configuration surface (~45 `TSFORGE_*` env vars,
19 CLI flags, `tsforge.config.json`, `~/.tsforge/models.json`). Today you can only
discover and change most of it by reading source or docs. That fails the core UX
bet: **nobody reads docs for two hours — people explore a tool through its TUI.**

The goal: anything a user might reasonably want to configure should be both
**discoverable** and **changeable** from inside the harness. Docs stay aligned, but
they are a fallback, not the primary interface. The TUI is the documentation.

Non-goal: exposing eval-only / harness-internal knobs (A-B experiment flags, the
gate-subprocess env bridge, RPC sandbox vars). Those are not "things a user wants."

## Core idea: a self-describing settings registry

One extensible registry is the single source of truth for user-facing config —
the same pattern as the (already shipped) Shift+Tab mode registry. Each setting
declares what it is, its current value, how to change it, and where it persists.

```ts
interface ISetting<T> {
  id: string;              // stable key, e.g. "model.active"
  group: string;           // "Model" | "Behavior" | "Tools" | "Conventions"
  label: string;           // short name shown in the menu
  describe: string;        // ONE line: what it does — this is the in-TUI "docs"
  read(ctx): T;            // current value, shown next to the label
  edit(ctx): Promise<T | null>;   // runs a menu/wizard flow; null = cancelled
  persist(ctx, value: T): Promise<void>;  // write to the right store
  applyLive?(ctx, value: T): void;        // hot-apply without restart, when possible
}
```

Because each entry is self-describing, three things fall out of one definition:
1. **`/config`** renders the registry as a browsable, grouped menu — you *see* every
   setting, its one-line description, and its current value. Discovery = browsing.
2. **Docs generation**: `flags.mdx` (the user-facing table) is generated from the
   registry, so it can never drift from what the TUI shows.
3. **Extensibility**: adding a setting is one registry entry — no new command, no
   new doc edit, no menu wiring.

## `/config` command

- New slash command `/config` (registry entry in `cli/commands.ts` + one `case` in
  the `command()` dispatcher — the standard pattern).
- Opens a grouped, keyboard-navigable menu built on the existing interactive
  primitives (`render/command-menu.ts` `pickCommand` for single-select; `render/
  wizard.ts` `runWizard` for multi-field flows like "add a model"). Alt-screen +
  raw-mode handling is already solved there and coexists with the status bar.
- Flow: open → arrow to a setting (its `describe` + current value visible) → Enter
  runs `edit()` → `persist()` writes the correct store → `applyLive()` reflects it
  immediately → menu shows the new value.

## Stores (persistence adapters)

| Store | Backed by | Reuse |
| --- | --- | --- |
| Model registry | `~/.tsforge/models.json` | `loadModelsConfig` / `saveModelsConfig` / `setActiveModel` |
| Project config | `tsforge.config.json` | `loadTsforgeConfig` / `writeSetupConfig` (atomic merge) |
| Session | in-memory (this run) | `session.setMode` / `setGate` / `setScope` |

`applyLive`: model → `provider.reconfigure()`; mode → `session.setMode`; gate/scope →
session setters. Settings that can't hot-apply say so and note "next session".

## v1 settings (the genuinely user-facing knobs)

- **Model** (`Model` group): switch active model; **add a model** (baseUrl / model /
  apiKey via a `runWizard` flow) → `saveModelsConfig` + live `reconfigure()`. Removes
  hand-editing `models.json`.
- **Behavior** (`tsforge.config.json`): default mode (`policy.mode`), gate command,
  editable scope.
- **Tools & features** (`Tools` group): web tools, TDD enforcement, script tool as
  friendly on/off. **Requires new plumbing** — see below.
- **Conventions**: interface naming, enums, test style — reuse the setup wizard's
  step definitions so `/config` and `setup` share them.

### Feature-toggle plumbing (needed for the Tools group)

Today `TSFORGE_WEB` / `TSFORGE_TDD` / `TSFORGE_NO_SCRIPT` etc. are env-only with
nothing persisted. To make them settable + sticky:
- Add a `features` block to `tsforge.config.json` (`{ web?, tdd?, script? }`).
- Change `config/flags.ts` to resolve **env → config → default** (env still wins as
  the escape hatch, so eval/CI is unaffected).
This is the one non-trivial code change; everything else is menu + persist wiring.

## Doc alignment

A small generator walks the registry and emits the user-facing rows of
`reference/flags.mdx` (id, description, default, store). A test asserts the committed
doc matches the generated output (same pattern as the existing `RULES.md` drift
check in CI), so docs can't silently drift from the TUI.

## Testing

- **Unit**: the registry (each setting's read/persist round-trips against a temp
  store); the menu reducer (pure, like the wizard reducer).
- **Real-PTY e2e** (in the gate): open `/config`, switch the active model against the
  stub server, assert it persisted to models.json AND hot-applied (status bar model
  changes); toggle a feature and assert the `features` block was written.
- **Doc-drift test**: generated `flags.mdx` rows == committed.

## Rollout

1. Registry + `/config` menu + Model and Behavior groups (no schema change).
2. `features` block + `flags.ts` env→config→default + Tools group.
3. Conventions group (reuse setup steps) + doc generator + drift test.
4. Later: `setup` wizard renders first-run onboarding from the same registry (one
   source of truth for both onboarding and live config).
