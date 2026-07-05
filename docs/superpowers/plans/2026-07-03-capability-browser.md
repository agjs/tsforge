# Capability Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every tsforge capability discoverable in-session — `/help` becomes an actionable, grouped capability browser over a self-describing registry, with the scaffold (boringstack/astro/vite) and recipe flows brought into the REPL, guarded by an anti-drift test.

**Architecture:** A pure `ICapability[]` registry (mirroring the existing `ISetting`/mode registries) is the single source of truth. A generic owned-stdin grouped-menu driver — extracted from the proven `/config` menu — renders both `/config` and the new capability browser. Selecting a row runs a command, opens an in-REPL wizard (scaffold/recipe), or shows a passive-capability explainer. An anti-drift unit test fails if any slash command or model tool ships without a registry entry.

**Tech Stack:** TypeScript (strict), Bun runtime, `node:readline` keypress loop, existing `src/render/wizard.ts` generic wizard, `src/scaffold/*`, Python `pty.fork` e2e harness.

## Global Constraints

- House rules (gate-enforced): no `as` casts, no `eslint-disable`, cyclomatic complexity ≤ 20, no non-null `!`, use `===`, explicit booleans, `I`-prefixed interfaces, prettier + `@stylistic/padding-line-between-statements` (blank line between statement kinds), `@typescript-eslint/no-floating-promises` (prefix fire-and-forget with `void`), `no-confusing-void-expression`, `prefer-optional-chain`, `no-dynamic-delete` (use `Reflect.deleteProperty`).
- Definition of done for any TUI/CLI change: a **real-terminal PTY e2e** asserting on the rendered buffer — not just unit tests.
- Reuse, don't re-roll: the generic wizard (`runWizard`, `manageInput`), the owned-stdin menu driver, `src/scaffold` functions, `loadRecipes`.
- Branch: `feat/capability-browser` (already created; the spec commit `ddd0daa` is on it).
- `bun run validate` (typecheck + lint + format + unit + all 3 PTY suites) must be green before "done".

## File Structure

- Create `packages/core/src/cli/capabilities.ts` — the `ICapability` registry + `buildCapabilities(deps)` (pure).
- Create `packages/core/tests/capabilities.test.ts` — registry unit + anti-drift tests.
- Create `packages/core/src/render/owned-menu.ts` — generic owned-stdin grouped-menu driver extracted from `config-menu.ts`.
- Modify `packages/core/src/cli/config-menu.ts` — migrate `runConfigMenu` onto `owned-menu.ts` (behavior unchanged).
- Create `packages/core/src/cli/capability-menu.ts` — `runCapabilityMenu(deps)` (the browser) + passive explainer sub-view.
- Create `packages/core/tests/capability-menu.test.ts` — render + selection unit tests.
- Modify `packages/core/src/cli.ts` — `/help` opens the browser on a TTY; add `openScaffold`/`openRecipe` deps.
- Create `packages/core/src/cli/repl-scaffold.ts` — `openScaffoldInRepl(deps)` in-REPL scaffold launcher.
- Create `packages/core/src/cli/repl-recipe.ts` — `openRecipePicker(deps)` in-REPL recipe launcher.
- Create `scripts/e2e-help-browser-pty.py` — real-terminal e2e; wire into `package.json` `e2e:pty`.
- Modify `apps/docs/src/content/docs/cli/interactive.mdx` — document `/help` as a browser.

---

### Task 1: Capability registry + anti-drift test

**Files:**
- Create: `packages/core/src/cli/capabilities.ts`
- Test: `packages/core/tests/capabilities.test.ts`

**Interfaces:**
- Consumes: `COMMANDS`, `takesArg` from `../cli/commands`; `TOOL_NAME` from `../agent`.
- Produces:
  ```ts
  export type CapabilityKind = "command" | "wizard" | "passive";
  export type CapabilityInvoke =
    | { readonly type: "run"; readonly command: string }
    | { readonly type: "prefill"; readonly command: string }
    | { readonly type: "wizard"; readonly opener: "scaffold" | "recipe" };
  export interface ICapability {
    readonly id: string;
    readonly group: string;
    readonly label: string;
    readonly describe: string;
    readonly kind: CapabilityKind;
    readonly detail?: string;
    readonly invoke?: CapabilityInvoke;
  }
  export interface ICapabilityDeps { readonly hasRecipes: boolean; }
  export function buildCapabilities(deps: ICapabilityDeps): ICapability[];
  export function capabilityCommandNames(caps: readonly ICapability[]): string[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/capabilities.test.ts
import { test, expect } from "bun:test";
import { buildCapabilities } from "../src/cli/capabilities";
import { COMMANDS } from "../src/cli/commands";
import { TOOL_NAME } from "../src/agent";

const deps = { hasRecipes: true };

test("every capability has group, label, non-empty describe, valid kind", () => {
  for (const c of buildCapabilities(deps)) {
    expect(c.group.length).toBeGreaterThan(0);
    expect(c.label.length).toBeGreaterThan(0);
    expect(c.describe.length).toBeGreaterThan(0);
    expect(["command", "wizard", "passive"]).toContain(c.kind);
  }
});

test("command/wizard capabilities carry an invoke; passive carry detail", () => {
  for (const c of buildCapabilities(deps)) {
    if (c.kind === "passive") {
      expect((c.detail ?? "").length).toBeGreaterThan(0);
    } else {
      expect(c.invoke).toBeDefined();
    }
  }
});

// ── the keystone: anti-drift ────────────────────────────────────────────────
test("ANTI-DRIFT: every slash command has a discovery home", () => {
  const caps = buildCapabilities(deps);
  const covered = new Set(
    caps
      .filter((c) => c.invoke?.type === "run" || c.invoke?.type === "prefill")
      .map((c) => (c.invoke?.type === "run" || c.invoke?.type === "prefill" ? c.invoke.command : "")),
  );
  // Commands intentionally excluded from the browser (they ARE the browser / trivial).
  const exempt = new Set(["/help", "/exit"]);

  for (const spec of COMMANDS) {
    if (exempt.has(spec.name)) {
      continue;
    }

    expect(covered.has(spec.name)).toBe(true);
  }
});

test("ANTI-DRIFT: every model tool has a discovery home", () => {
  const passiveIds = new Set(
    buildCapabilities(deps)
      .filter((c) => c.kind === "passive")
      .map((c) => c.id),
  );
  // Tools surfaced as their own capability id `tool.<name>`. Scaffolders/core
  // edit tools are represented by the "Build"/"Core" rows, so exempt them.
  const exempt = new Set([
    "read", "run", "edit", "create", "edit_lines",
    "scaffold_web", "scaffold_ui", "scaffold_routes", "add_dependency",
  ]);

  for (const tool of Object.values(TOOL_NAME)) {
    if (exempt.has(tool)) {
      continue;
    }

    expect(passiveIds.has(`tool.${tool}`)).toBe(true);
  }
});

test("recipe row is present only when recipes exist", () => {
  expect(buildCapabilities({ hasRecipes: true }).some((c) => c.id === "recipe")).toBe(true);
  expect(buildCapabilities({ hasRecipes: false }).some((c) => c.id === "recipe")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/tests/capabilities.test.ts`
Expected: FAIL — `Cannot find module '../src/cli/capabilities'`.

- [ ] **Step 3: Implement `buildCapabilities`**

Author `packages/core/src/cli/capabilities.ts`. Build the list from three sources so the anti-drift tests pass:
1. **Command rows** — one per `COMMANDS` entry except `/help`, `/exit`. `kind:"command"`, `invoke:{ type: takesArg(spec) ? "prefill" : "run", command: spec.name }`, `describe: spec.summary`, grouped per §2 of the spec (Build / Understand / Steer / Session). Map each command name to its group via a small `Record<string,string>`; any unmapped command falls in "Session & cost" (keeps the anti-drift test green if a command is added).
2. **Wizard rows** — `{ id:"scaffold", group:"Build something new", label:"Scaffold a project", describe:"Stand up a new project — boringstack (full stack), astro (static site), or vite (web).", kind:"wizard", invoke:{type:"wizard",opener:"scaffold"} }`; and, when `deps.hasRecipes`, `{ id:"recipe", group:"Build something new", label:"Run a recipe", describe:"Run a saved build+gate flow from .tsforge/recipes.", kind:"wizard", invoke:{type:"wizard",opener:"recipe"} }`.
3. **Passive rows** — one per model tool that runs invisibly, id `tool.<name>`, `kind:"passive"`, group `"The model's tools (always on)"`, each with a non-empty `detail`. Cover at least: `git_context`, `web_fetch`/`web_search` (one "web research" row is not enough for the tool-level anti-drift test — give each surfaced tool its own `tool.<name>` id OR widen the exempt set; simplest: one passive row per non-exempt tool name). Use a `Record<toolName, {label,describe,detail}>` so each has real copy.

`capabilityCommandNames` returns the `command`/`prefill` command strings (used by tests + wiring).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/tests/capabilities.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun x eslint packages/core/src/cli/capabilities.ts packages/core/tests/capabilities.test.ts
git add packages/core/src/cli/capabilities.ts packages/core/tests/capabilities.test.ts
git commit --no-gpg-sign -m "feat(cli): capability registry + anti-drift test"
```

---

### Task 2: Extract the generic owned-stdin menu driver

Extract the menu loop from `config-menu.ts` (`runConfigMenu`) into a reusable driver so `/config` and `/help` share one battle-tested implementation. The existing config unit tests + `scripts/e2e-config-repl-pty.py` (12/12) are the safety net — they must stay green.

**Files:**
- Create: `packages/core/src/render/owned-menu.ts`
- Modify: `packages/core/src/cli/config-menu.ts`
- Test: existing `packages/core/tests/config-menu.test.ts` + `scripts/e2e-config-repl-pty.py` (unchanged, must pass)

**Interfaces:**
- Produces:
  ```ts
  export interface IMenuRow { readonly group: string; readonly label: string;
    readonly describe: string; readonly value?: string; }
  export interface IOwnedMenuDeps {
    readonly color: boolean;
    readonly title: string;            // e.g. "tsforge config" / "tsforge — what can I do?"
    readonly subtitle: string;         // e.g. "Settings · change anything here"
    readonly footer: string;           // e.g. "↑/↓ move   enter change   esc done"
    readonly suspend: () => void;
    readonly resume: () => void;
    readonly rows: () => readonly IMenuRow[];   // re-read after each activation (live values)
    readonly onSelect: (index: number) => void | Promise<void>;
    readonly onExit?: () => void;      // optional: draw an explainer sub-view yourself
  }
  export function runOwnedMenu(deps: IOwnedMenuDeps): Promise<void>;
  ```
- The driver owns: alt-screen enter/exit, `emitKeypressEvents`, keypress stash/restore, the `inert` editor-gate handshake via `suspend`/`resume` (host wires `editorControl.setInputInert`), ↑/↓ nav with `clampIndex`, Enter → `onSelect(cursor)` then redraw, Esc → resolve. Rendering: group headers + per-row `label · value` + dim `describe` line (verbatim from the current `renderMenu`), truncating values with the existing `oneLine`.

- [ ] **Step 1: Extract the driver (no behavior change)**

Move the `renderMenu`/keypress-loop internals of `runConfigMenu` into `runOwnedMenu`. `renderMenu` becomes a pure function over `IMenuRow[]` + cursor + color (keep exporting a thin `renderMenu` from `owned-menu.ts` for tests). Keep `oneLine`, `clampIndex` imports.

- [ ] **Step 2: Migrate `runConfigMenu` onto the driver**

Rewrite `runConfigMenu(deps)` to build `IMenuRow[]` from `buildSettings(deps)` (label + `s.read()` value + `s.describe`), pass `onSelect` = the existing setting activate/edit logic, and delegate the loop to `runOwnedMenu`. The text-field edit sub-view stays in `config-menu.ts` (config-specific), invoked from `onSelect`.

- [ ] **Step 3: Run the config safety net**

Run: `bun test packages/core/tests/config-menu.test.ts` → PASS.
Run: `python3 scripts/e2e-config-repl-pty.py` → `15/15 — ALL PASS` (descriptions render, toggles flip, double-type stays fixed, editor works after).

- [ ] **Step 4: Typecheck, lint, commit**

```bash
bun run typecheck && bun x eslint packages/core/src/render/owned-menu.ts packages/core/src/cli/config-menu.ts
git add packages/core/src/render/owned-menu.ts packages/core/src/cli/config-menu.ts
git commit --no-gpg-sign -m "refactor(render): extract generic owned-stdin menu driver; /config uses it"
```

---

### Task 3: The capability browser (`runCapabilityMenu`)

**Files:**
- Create: `packages/core/src/cli/capability-menu.ts`
- Test: `packages/core/tests/capability-menu.test.ts`

**Interfaces:**
- Consumes: `buildCapabilities`, `ICapability` from `./capabilities`; `runOwnedMenu`, `renderMenu`, `IMenuRow` from `../render/owned-menu`.
- Produces:
  ```ts
  export interface ICapabilityMenuDeps {
    readonly color: boolean;
    readonly hasRecipes: boolean;
    readonly suspend: () => void;
    readonly resume: () => void;
    readonly runCommand: (command: string) => void;   // "run" → dispatch a slash command
    readonly prefill: (command: string) => void;      // "prefill" → put "<cmd> " in the input
    readonly openWizard: (opener: "scaffold" | "recipe") => Promise<void>;
    readonly showDetail: (cap: ICapability) => Promise<void>; // passive explainer sub-view
  }
  export function capabilityRows(caps: readonly ICapability[]): IMenuRow[];
  export function runCapabilityMenu(deps: ICapabilityMenuDeps): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/capability-menu.test.ts
import { test, expect } from "bun:test";
import { capabilityRows } from "../src/cli/capability-menu";
import { buildCapabilities } from "../src/cli/capabilities";
import { renderMenu } from "../src/render/owned-menu";

test("capabilityRows preserves group + label + describe for every capability", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const rows = capabilityRows(caps);

  expect(rows.length).toBe(caps.length);
  for (let i = 0; i < caps.length; i++) {
    expect(rows[i]?.group).toBe(caps[i]?.group);
    expect(rows[i]?.label).toBe(caps[i]?.label);
    expect(rows[i]?.describe).toBe(caps[i]?.describe);
  }
});

test("rendered browser shows every capability's description (screen IS the docs)", () => {
  const caps = buildCapabilities({ hasRecipes: true });
  const screen = renderMenu(capabilityRows(caps), 0, false);

  for (const c of caps) {
    expect(screen).toContain(c.describe);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/core/tests/capability-menu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capabilityRows` + `runCapabilityMenu`**

`capabilityRows` maps each `ICapability` → `{ group, label, describe }` (no `value` — the browser has no live values). `runCapabilityMenu` builds caps via `buildCapabilities({hasRecipes})`, calls `runOwnedMenu` with title `"tsforge — what can I do?"`, footer `"↑/↓ move   enter run/open   esc close"`, and `onSelect(i)` that dispatches by the capability's `kind`/`invoke`:
- `run` → `deps.runCommand(cmd)` then the menu resolves (close).
- `prefill` → `deps.prefill(cmd)` then close.
- `wizard` → `await deps.openWizard(opener)` (menu closes; wizard owns the screen).
- `passive` → `await deps.showDetail(cap)` (sub-view; returns to the list — implement as `onSelect` redrawing after the detail promise, keeping the menu open).

To keep the list open after a passive explainer but close after an action, model `onSelect` to return, and have the passive branch NOT resolve the menu (the driver redraws), while action branches call a provided `close()` — expose `close` via an extra `runOwnedMenu` affordance OR implement the browser's own thin loop reusing `renderMenu`. Prefer: give `IOwnedMenuDeps.onSelect` a `{ close: () => void }` argument so a row can choose to close or stay.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/core/tests/capability-menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun x eslint packages/core/src/cli/capability-menu.ts packages/core/tests/capability-menu.test.ts
git add packages/core/src/cli/capability-menu.ts packages/core/tests/capability-menu.test.ts
git commit --no-gpg-sign -m "feat(cli): capability browser menu (runCapabilityMenu)"
```

---

### Task 4: In-REPL scaffold launcher

**Files:**
- Create: `packages/core/src/cli/repl-scaffold.ts`
- Test: `packages/core/tests/repl-scaffold.test.ts`

**Interfaces:**
- Consumes: `buildScaffoldSteps`, `stateToAnswers`, `answersToPlan`, `runScaffold`, `loadBundledManifest`, `realFs`, `realRunner`, `realPoller`, `IArchetype` from `../scaffold`; `runWizard` from `../render/wizard`.
- Produces:
  ```ts
  export interface IReplScaffoldDeps {
    readonly suspend: () => void; readonly resume: () => void;
    readonly out: (s: string) => void;
  }
  export function archetypeStep(): IWizardStep; // single-select: boringstack/astro/vite
  export function openScaffoldInRepl(deps: IReplScaffoldDeps): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test (pure step builder)**

```ts
// packages/core/tests/repl-scaffold.test.ts
import { test, expect } from "bun:test";
import { archetypeStep } from "../src/cli/repl-scaffold";

test("archetype step offers boringstack, astro, vite", () => {
  const step = archetypeStep();

  expect(step.kind).toBe("single");
  const values = step.options.map((o) => o.value);
  expect(values).toEqual(["boringstack", "astro", "vite"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/core/tests/repl-scaffold.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `openScaffoldInRepl`**

`archetypeStep()` returns a single-select `IWizardStep` with the three options + a helpful `describe` each. `openScaffoldInRepl`: `deps.suspend()`; run `runWizard` (with `manageInput:false`) over `[archetypeStep(), ...buildScaffoldSteps(manifest, archetype)]` — since later steps depend on the chosen archetype, run the archetype step first (its own `runWizard`), then build+run the remaining steps for that archetype; convert with `stateToAnswers` → `answersToPlan` → `runScaffold({fs:realFs, runner:realRunner, poller:realPoller, ...})`; print the same handoff block `scaffoldMode` prints (dir, sha, boot, gate command); `deps.resume()` in a `finally`. For `vite`, delegate to the existing `--web` skeleton path rather than boringstack clone.

- [ ] **Step 4: Run tests + typecheck/lint, commit**

```bash
bun test packages/core/tests/repl-scaffold.test.ts && bun run typecheck && bun x eslint packages/core/src/cli/repl-scaffold.ts packages/core/tests/repl-scaffold.test.ts
git add packages/core/src/cli/repl-scaffold.ts packages/core/tests/repl-scaffold.test.ts
git commit --no-gpg-sign -m "feat(cli): in-REPL scaffold launcher (boringstack/astro/vite)"
```

---

### Task 5: In-REPL recipe picker

**Files:**
- Create: `packages/core/src/cli/repl-recipe.ts`
- Test: `packages/core/tests/repl-recipe.test.ts`

**Interfaces:**
- Consumes: `loadRecipes`, `ITaskRecipe` from `../config/recipes`; `runOwnedMenu`/`renderMenu` from `../render/owned-menu`.
- Produces:
  ```ts
  export function recipeRows(recipes: readonly ITaskRecipe[]): IMenuRow[];
  export interface IReplRecipeDeps {
    readonly cwd: string; readonly color: boolean;
    readonly suspend: () => void; readonly resume: () => void;
    readonly runRecipe: (recipe: ITaskRecipe) => void;
  }
  export function openRecipePicker(deps: IReplRecipeDeps): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/repl-recipe.test.ts
import { test, expect } from "bun:test";
import { recipeRows } from "../src/cli/repl-recipe";

test("recipeRows renders id as label + description (or a fallback) as describe", () => {
  const rows = recipeRows([
    { id: "ship-fix", description: "fix to green then review" },
    { id: "bare" },
  ]);

  expect(rows[0]).toEqual({ group: "Recipes", label: "ship-fix", describe: "fix to green then review" });
  expect(rows[1]?.describe.length).toBeGreaterThan(0); // fallback, never empty
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/core/tests/repl-recipe.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `recipeRows` maps recipes → rows (`describe` falls back to `"(no description)"`). `openRecipePicker`: `loadRecipes(cwd)`; if empty, `out` a note and return; else `runOwnedMenu` over `recipeRows`, `onSelect` → `deps.runRecipe(recipe)` + close.

- [ ] **Step 4: Run tests + typecheck/lint, commit**

```bash
bun test packages/core/tests/repl-recipe.test.ts && bun run typecheck && bun x eslint packages/core/src/cli/repl-recipe.ts packages/core/tests/repl-recipe.test.ts
git add packages/core/src/cli/repl-recipe.ts packages/core/tests/repl-recipe.test.ts
git commit --no-gpg-sign -m "feat(cli): in-REPL recipe picker"
```

---

### Task 6: Wire `/help` to the browser

**Files:**
- Modify: `packages/core/src/cli.ts` (the `command()` `case "help"`, and the deps wiring near `handleConfig`)

**Interfaces:**
- Consumes: `runCapabilityMenu` (Task 3), `openScaffoldInRepl` (Task 4), `openRecipePicker` (Task 5), `loadRecipes`.

- [ ] **Step 1: Implement `handleHelp`**

Add a `handleHelp` closure mirroring `handleConfig`: on a TTY, `await runCapabilityMenu({ color, hasRecipes: (await loadRecipes(args.dir)).length > 0, suspend, resume, runCommand: (c) => void runLine(c), prefill: (c) => editorControl?.getBuffer().setText(\`\${c} \`), openWizard, showDetail })`. `openWizard("scaffold")` → `openScaffoldInRepl({suspend,resume,out})`; `openWizard("recipe")` → `openRecipePicker({cwd:args.dir,color,suspend,resume,runRecipe:(r)=>void runLine(...) })`. `suspend`/`resume` reuse the exact `handleConfig` deps (including `editorControl?.setInputInert(true/false)` — the inert gate). Non-TTY: keep printing `HELP` (the `formatHelp()` text) so pipes/logs are unchanged.

- [ ] **Step 2: Update `case "help"`** to `await handleHelp();` (was `process.stdout.write(\`\${HELP}\n\`)`), keeping the non-TTY fallback inside `handleHelp`.

- [ ] **Step 3: Verify build + config e2e unaffected**

Run: `bun run typecheck && bun x eslint packages/core/src/cli.ts` → clean.
Run: `python3 scripts/e2e-config-repl-pty.py` → still `15/15` (shared driver intact).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cli.ts
git commit --no-gpg-sign -m "feat(cli): /help opens the capability browser (TTY); text fallback off-TTY"
```

---

### Task 7: Real-terminal e2e + docs

**Files:**
- Create: `scripts/e2e-help-browser-pty.py`
- Modify: `package.json` (`e2e:pty` chain), `apps/docs/src/content/docs/cli/interactive.mdx`

- [ ] **Step 1: Write the e2e** (model on `scripts/e2e-config-repl-pty.py`: embedded stub server, `pty.fork`, `NO_UPDATE_NOTIFIER=1`). Assert, on the real buffer:
  - typing `/help` + Enter opens the browser (title `tsforge — what can I do?` renders).
  - group headers render (`Build something new`, `The model's tools`).
  - every visible row shows its `describe` line (pick 3 stable markers incl. the scaffold row `boringstack`).
  - arrow to a passive row (e.g. `git context`), Enter → the explainer `detail` shows; Esc returns to the list.
  - arrow to "Scaffold a project", Enter → the archetype wizard opens (`boringstack`, `astro`, `vite` all visible); Esc cancels back to the REPL.
  - Esc closes the browser; tsforge STILL RUNNING; typing a marker into the editor after renders ONCE (inert gate cleared — the regression we fixed).

- [ ] **Step 2: Run it** — `python3 scripts/e2e-help-browser-pty.py` → `ALL PASS`.

- [ ] **Step 3: Wire into validate** — add `&& python3 scripts/e2e-help-browser-pty.py` to the `e2e:pty` script in `package.json`.

- [ ] **Step 4: Docs** — in `cli/interactive.mdx`, change the `/help` row to "open the capability browser — every command + hidden capability (scaffold stacks, recipes, the model's tools), each with a description; select to run/open" and add a sentence that scaffold + recipes are reachable from `/help`.

- [ ] **Step 5: Full gate + commit**

```bash
bun run validate   # green: typecheck+lint+format+unit+ALL pty suites (incl. the new one)
git add scripts/e2e-help-browser-pty.py package.json apps/docs/src/content/docs/cli/interactive.mdx
git commit --no-gpg-sign -m "test(e2e): /help capability browser (real pty) + docs"
```

---

## Self-Review

**Spec coverage:** registry (Task 1) ✓; `/help` browser reusing the `/config` driver (Tasks 2–3, 6) ✓; actionable command/wizard/passive selection (Task 3) ✓; scaffold-in-REPL boringstack/astro/vite (Task 4) ✓; recipe-in-REPL (Task 5) ✓; `/` palette stays the runner (untouched — no task needed) ✓; anti-drift test (Task 1) ✓; real-PTY e2e (Task 7) ✓. Deferred items (proactive surfacing, visible-passive annotations, onboarding, generated docs page) are explicitly out of scope per the spec.

**Placeholder scan:** every code step has real code or exact function names from the codebase; test steps have runnable assertions; commands have expected output. No "TBD"/"handle edge cases".

**Type consistency:** `ICapability`/`CapabilityKind`/`CapabilityInvoke` are used identically in Tasks 1, 3, 6. `IMenuRow`/`runOwnedMenu` defined in Task 2 and consumed unchanged in Tasks 3, 5. `openScaffoldInRepl`/`openRecipePicker` signatures match their call sites in Task 6. Scaffold archetype values `["boringstack","astro","vite"]` consistent between Task 4's step and the test.

**One risk flagged for the implementer:** Task 2 refactors the freshly-stabilized `/config` driver. The `scripts/e2e-config-repl-pty.py` (15/15, incl. the double-type + inert-gate regressions) is the safety net — run it after every change in Task 2 and do NOT weaken it. If extraction proves risky, fall back to a standalone `runCapabilityMenu` loop that duplicates the ~40-line keypress loop (accept the duplication over destabilizing `/config`).
