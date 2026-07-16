# BoringStack Full-Stack Build Loop — Implementation Plan (MVP driver)

> **SUPERSEDED (2026-07-15)** by the unified build loop — see `docs/superpowers/specs/2026-07-14-unified-build-loop-design.md`. The implement/evaluate split described below is removed; the real gate now runs inside the loop as a composed `IGate`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the harness build a real full-stack feature on a cloned+booted BoringStack, one vertical slice at a time — the harness runs BoringStack's generators + deterministic wiring, the model fills domain logic + tests, evaluated by BoringStack's own `validate`.

**Architecture:** Reuse the existing greenfield engine (`loop/greenfield/run.ts` `runGreenfield`: checklist → `implement` → `evaluate` → freeze). Add a BoringStack driver that supplies the two injected deps: `implement` = harness runs `new:resource` + 3 wiring edits + format + `db:push`, then the model fills domain fields/logic + writes required test siblings (scope frozen to that resource's files); `evaluate` = run BoringStack's composed `validate` in a container that mounts the whole clone. Single-project MVP (port-isolation and generator auto-wiring are separate follow-on plans).

**Tech Stack:** TypeScript (Bun), the existing `Session` loop + `loop/scope` freeze, `docker exec`/`docker compose` against a booted BoringStack clone (Bun+Elysia API, Vite+React UI, Postgres, Drizzle), TanStack Query on the UI.

## Global Constraints

- No `as` casts (`as const`/`satisfies` OK); no `eslint-disable`; cognitive-complexity ≤ 20; shared AST walkers. (tsforge house rules — verbatim.)
- Run full `bun run validate` green before "done"; read the real `N pass / M fail` from output, NOT the harness exit-code notification.
- Never relax the gate. The "done" bar is BoringStack's own `validate` + `check`.
- The harness runs the mechanical generator + wiring steps; the model fills domain + writes tests.
- DB sync in dev is `db:push` (NOT raw `drizzle-kit migrate` — it fails silently against a stack whose schema was seeded by the `api-migrate` service).
- Gate/meta-rules must run where the FULL repo tree is visible (`.github/`, repo root) AND where the container-volume bins (`tsc`/`eslint`/`knip`) exist → run `validate` inside a container that mounts the whole clone.

---

## File Structure

- Create `packages/core/src/loop/boringstack/plan-resources.ts` — plan a build goal into a checklist of RESOURCES (entities), each an `IFeature` whose `id` is the PascalName passed to the generators.
- Create `packages/core/src/loop/boringstack/wire-resource.ts` — the three deterministic API wiring edits (routes/app/swagger) as pure string transforms + a `wireResource(cwd, name)` that applies them.
- Create `packages/core/src/loop/boringstack/generate.ts` — `generateResource(cwd, name, exec)` (run `new:resource`, format, `db:push`) and `generateFeature(cwd, name, exec)` (UI `new:feature` + `generate:api`), where `exec` is an injected command runner (so tests don't shell out).
- Create `packages/core/src/loop/boringstack/gate.ts` — `runBoringstackGate(cwd, exec)`: runs the composed `validate` in a full-repo container; returns `{ passed, output }`.
- Create `packages/core/src/loop/boringstack/build.ts` — `boringstackDeps({host, cwd, exec, evaluator})` (the `IGreenfieldDeps`) + `runBoringstackBuild(opts)` (prepareState → runGreenfield). Mirrors the shape of the removed `web-greenfield.ts`.
- Create `packages/core/src/loop/boringstack/refine-prompt.ts` — `refinePrompt(feature)`: names the exact generated files the model may edit + the test-sibling paths it must create + the domain-fill instructions.
- Create tests under `packages/core/tests/boringstack-*.test.ts` (one per module).
- Modify `packages/core/scripts/headless-build.ts` — behind `TSFORGE_BORINGSTACK=1`, route to `runBoringstackBuild` against a pre-scaffolded clone dir.

**Injected command runner** (keeps every module unit-testable — no real docker/shell in tests):

```ts
// packages/core/src/loop/boringstack/exec.ts
export interface IExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (
  argv: readonly string[],
  opts: { cwd: string }
) => Promise<IExecResult>;
```

---

### Task 1: Resource planner

**Files:**
- Create: `packages/core/src/loop/boringstack/plan-resources.ts`
- Test: `packages/core/tests/boringstack-plan-resources.test.ts`

**Interfaces:**
- Consumes: `IProvider` (from `../../inference`), `IFeature`/`IGreenfieldState` (from `../greenfield/greenfield.types`).
- Produces: `planResources(provider: IProvider, goal: string): Promise<IFeature[]>` — each `IFeature.id` is a PascalName (e.g. `Invoice`), `desc` the one-line behaviour, `passes:false`, `attempts:0`.

- [ ] **Step 1: Write the failing test** — a fake provider returns a JSON resource list; assert parsed into `IFeature[]` with PascalCase ids and the retry path (temp 0 → 0.4) on a malformed first reply.

```ts
import { test, expect, describe } from "bun:test";
import { planResources } from "../src/loop/boringstack/plan-resources";

const provider = (replies: string[]) => {
  let i = 0;
  return { complete: async () => ({ content: replies[i++] ?? "", toolCalls: [] }) };
};

describe("planResources", () => {
  test("parses a resource checklist into IFeatures", async () => {
    const p = provider([
      JSON.stringify({ resources: [
        { id: "Invoice", desc: "invoices CRUD" },
        { id: "Customer", desc: "customers CRUD" },
      ] }),
    ]);
    const feats = await planResources(p, "build a billing app");
    expect(feats.map((f) => f.id)).toEqual(["Invoice", "Customer"]);
    expect(feats.every((f) => !f.passes && f.attempts === 0)).toBe(true);
  });

  test("retries once on a malformed first reply", async () => {
    const p = provider(["not json", JSON.stringify({ resources: [{ id: "Invoice", desc: "x" }] })]);
    const feats = await planResources(p, "x");
    expect(feats).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/core/tests/boringstack-plan-resources.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `planResources` — a `RESOURCE_SYSTEM` prompt ("emit `{resources:[{id:PascalName, desc}]}`"), two attempts (temp 0 then 0.4), `JSON.parse` guarded by a narrow shape check (no `as`), map to `IFeature`. Mirror the retry structure of the removed `planWebFeatures` (see git history of `loop/greenfield/plan.ts`).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): resource planner"`.

---

### Task 2: Deterministic API wiring

**Files:**
- Create: `packages/core/src/loop/boringstack/wire-resource.ts`
- Test: `packages/core/tests/boringstack-wire-resource.test.ts`

**Interfaces:**
- Produces:
  - `wireRoutesFile(src: string, name: string): string` — adds `import <camel>Routes from "../../api/<camel>/<camel>.routes";` after the last import and `<camel>: <camel>Routes,` into the `routes` object.
  - `wireAppFile(src: string, name: string): string` — inserts `.group("/api/v1/<camel>", (group) => group.use(routes.<camel>))` before the closing `)` of the group chain.
  - `wireSwaggerFile(src: string, name: string): string` — adds `{ name: "<Name>", description: "<Name> resource" },` into the `tags` array.
  - `wireResource(cwd: string, name: string): Promise<void>` — reads/edits the three real files (`src/config/routes/routes.ts`, `src/config/app/app.ts`, `src/config/swagger/swagger.ts` under `apps/api`).

The three string transforms are validated by Phase B (the exact edits that produced a green typecheck). Test them as pure functions against fixture snippets copied from a real BoringStack clone.

- [ ] **Step 1: Write failing tests** — for each transform, feed a minimal fixture (the real shapes from `apps/api/src/config/*`) and assert the resource line/import/group/tag is present and the anchor text is preserved.

```ts
import { test, expect, describe } from "bun:test";
import { wireRoutesFile, wireAppFile, wireSwaggerFile } from "../src/loop/boringstack/wire-resource";

describe("wireRoutesFile", () => {
  test("adds import + object entry", () => {
    const src = `import healthRoutes from "../../api/health/health.routes";\n\nexport const routes = {\n  health: healthRoutes,\n};\n`;
    const out = wireRoutesFile(src, "Invoice");
    expect(out).toContain('import invoiceRoutes from "../../api/invoice/invoice.routes";');
    expect(out).toContain("invoice: invoiceRoutes,");
  });
});

describe("wireAppFile", () => {
  test("inserts the group mount", () => {
    const src = `  return (\n    app\n      .use(routes.health)\n  );\n`;
    expect(wireAppFile(src, "Invoice")).toContain('.group("/api/v1/invoice", (group) => group.use(routes.invoice))');
  });
});

describe("wireSwaggerFile", () => {
  test("adds a tag", () => {
    const src = `    tags: [\n      { name: "Health", description: "probes" },\n    ],\n`;
    expect(wireSwaggerFile(src, "Invoice")).toContain('{ name: "Invoice", description: "Invoice resource" }');
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the three transforms (anchor on `export const routes = {` / the last `.group(...)` before `\n  );` / the `tags: [` array) + `wireResource` reading the real paths. Keep each function cc ≤ 20; share a `insertBeforeLast(src, anchor, insertion)` helper.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): deterministic API wiring"`.

---

### Task 3: Generator + DB-sync runner

**Files:**
- Create: `packages/core/src/loop/boringstack/exec.ts` (the `Exec` type above)
- Create: `packages/core/src/loop/boringstack/generate.ts`
- Test: `packages/core/tests/boringstack-generate.test.ts`

**Interfaces:**
- Consumes: `Exec`, `wireResource` (Task 2).
- Produces: `generateResource(cwd: string, name: string, exec: Exec): Promise<void>` — runs, in order: `new:resource -- <Name>` (in `apps/api`), `wireResource(cwd, name)`, a prettier `--write` pass over `apps/api/src apps/api/tests`, then `db:push` (in `apps/api`). Throws with the captured output if any `exec` returns non-zero.

- [ ] **Step 1: Write failing test** — a recording fake `Exec` returns `{code:0}`; assert `generateResource` calls the commands in order (new:resource → prettier → db:push) with the right cwd, and that a non-zero `new:resource` throws.

```ts
import { test, expect, describe } from "bun:test";
import { generateResource } from "../src/loop/boringstack/generate";

const recorder = () => {
  const calls: string[][] = [];
  const exec = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, stdout: "", stderr: "" }; };
  return { calls, exec };
};

describe("generateResource", () => {
  test("runs new:resource, formats, then db:push", async () => {
    const { calls, exec } = recorder();
    await generateResource("/repo", "Invoice", exec);
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("new:resource") && c.includes("Invoice"))).toBe(true);
    expect(joined.findIndex((c) => c.includes("db:push"))).toBeGreaterThan(
      joined.findIndex((c) => c.includes("new:resource"))
    );
  });

  test("throws when a generator command fails", async () => {
    const exec = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(generateResource("/repo", "Invoice", exec)).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `generateResource` (sequential `exec` calls, cwd `<cwd>/apps/api`, throw-on-nonzero with captured stderr; call `wireResource` between generate and format). Add `generateFeature` (UI: `new:feature <Name>` in `apps/ui`, then `generate:api`) — same shape.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): generator + db:push runner"`.

---

### Task 4: Gate runner (full-repo container)

**Files:**
- Create: `packages/core/src/loop/boringstack/gate.ts`
- Test: `packages/core/tests/boringstack-gate.test.ts`

**Interfaces:**
- Consumes: `Exec`.
- Produces: `runBoringstackGate(cwd: string, exec: Exec): Promise<{ passed: boolean; output: string }>` — runs the composed gate `(cd apps/api && bun run validate) && (cd apps/ui && bun run validate) && bun run check` inside a container that mounts the WHOLE clone at the repo root (so meta-rules see `.github/` AND the container bins exist). `passed = code === 0`.

**Phase B finding baked in:** running per-app in the `apps/api`-only dev container false-fails `pre-push-ci-parity` (no repo root) — so the gate MUST run with the whole clone mounted. The MVP uses a one-off `docker run --rm -v <cwd>:/repo -w /repo <api-dev-image> sh -c '<gate>'` (image reused from the booted stack), or `docker compose run` with a repo-root working dir. The chosen invocation is captured in the exec argv here.

- [ ] **Step 1: Write failing test** — fake `Exec` returns `{code:0}` → `passed:true`; `{code:1, stdout:"✗ typecheck"}` → `passed:false` and output surfaced. Assert the argv contains the composed gate string and a repo-root mount/workdir.

```ts
import { test, expect, describe } from "bun:test";
import { runBoringstackGate } from "../src/loop/boringstack/gate";

describe("runBoringstackGate", () => {
  test("passes on exit 0", async () => {
    const exec = async () => ({ code: 0, stdout: "ok", stderr: "" });
    expect((await runBoringstackGate("/repo", exec)).passed).toBe(true);
  });
  test("fails and surfaces output on non-zero", async () => {
    const exec = async () => ({ code: 1, stdout: "✗ typecheck FAILED", stderr: "" });
    const r = await runBoringstackGate("/repo", exec);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("typecheck");
  });
  test("runs with the whole repo mounted at the working root", async () => {
    let seen: string[] = [];
    const exec = async (argv: readonly string[]) => { seen = [...argv]; return { code: 0, stdout: "", stderr: "" }; };
    await runBoringstackGate("/repo", exec);
    const j = seen.join(" ");
    expect(j).toContain("apps/api && bun run validate");
    expect(j).toContain("/repo");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `runBoringstackGate` — build the `docker run --rm -v <cwd>:/repo -w /repo <image> sh -lc "<gate>"` argv; return `{passed: code===0, output: stdout+stderr}`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): full-repo gate runner"`.

---

### Task 5: Refine prompt

**Files:**
- Create: `packages/core/src/loop/boringstack/refine-prompt.ts`
- Test: `packages/core/tests/boringstack-refine-prompt.test.ts`

**Interfaces:**
- Consumes: `IFeature`.
- Produces: `refinePrompt(feature: IFeature): string` — names the generated files the model must fill (`apps/api/src/api/<camel>/<camel>.{schemas,service,types}.ts`, `apps/ui/src/features/<camel>/…`), REQUIRES writing the test siblings (`tests/api/<camel>/<camel>.{routes,service}.test.ts`), and the domain-fill instructions (real fields in schemas/types, real service logic, no `as`). States the freeze: only this resource's files are editable.

- [ ] **Step 1: Write failing test** — assert the prompt contains the resource id, the generated file paths, the required test-sibling paths, and the freeze wording.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): refine prompt"`.

---

### Task 6: Build driver (deps + runBoringstackBuild)

**Files:**
- Create: `packages/core/src/loop/boringstack/build.ts`
- Test: `packages/core/tests/boringstack-build.test.ts`

**Interfaces:**
- Consumes: `runGreenfield`/`prepareState` (`../greenfield/run`), `IGreenfieldDeps`/`IFeature` (`../greenfield/greenfield.types`), `evaluateFeature` (`../greenfield/evaluate`), `judgeFeature` (`../greenfield/judge`), Tasks 1-5, and a build host `{ setScope(globs), send(msg) }` (the `Session` satisfies it structurally — same as the removed `IWebBuildHost`).
- Produces:
  - `boringstackDeps(opts: { host; cwd; exec; evaluator }): IGreenfieldDeps` — `implement(feature)` = `generateResource(cwd, feature.id, exec)` → `host.setScope(scopeFor(feature.id))` → `host.send(refinePrompt(feature))`; `evaluate(feature)` = `evaluateFeature(feature, { gate: () => runBoringstackGate(cwd, exec), browser: skip, judge: () => judgeFeature(evaluator, …) })`.
  - `scopeFor(name: string): string[]` — the freeze globs for a resource: `apps/api/src/api/<camel>/**`, `apps/api/tests/api/<camel>/**`, `apps/ui/src/features/<camel>/**`, plus the shared wiring files (routes/app/swagger — writable because the harness, not the model, edits them; or excluded from model scope and edited pre-send).
  - `runBoringstackBuild(opts): Promise<IGreenfieldResult>` — `prepareState(cwd, goal, (g) => planResources(planner, g))` → `runGreenfield(cwd, state, boringstackDeps(...), { onEvent })`.

- [ ] **Step 1: Write failing test** — a fake host records `setScope`/`send`; a recording `exec` returns 0; assert `implement` runs `generateResource` then `send(refinePrompt)` and freezes to the resource scope; assert `evaluate` maps a gate exit-0 to `passed:true`.

```ts
import { test, expect, describe } from "bun:test";
import { boringstackDeps } from "../src/loop/boringstack/build";

const host = () => { const scopes: string[][] = []; const sent: string[] = [];
  return { scopes, sent, setScope: (g: string[]) => scopes.push(g), send: async (m: string) => { sent.push(m); return { status: "done", turns: 1 }; } }; };
const evaluator = { complete: async () => ({ content: '{"pass":true,"notes":"ok"}', toolCalls: [] }) };

describe("boringstackDeps.implement", () => {
  test("generates then sends a scoped refine", async () => {
    const h = host();
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    const deps = boringstackDeps({ host: h, cwd: "/repo", exec, evaluator });
    await deps.implement({ id: "Invoice", desc: "x", passes: false, attempts: 0 }, { goal: "g", features: [] });
    expect(h.sent[0]).toContain("Invoice");
    expect(h.scopes.at(-1)?.some((g) => g.includes("api/invoice"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `scopeFor`, `boringstackDeps`, `runBoringstackBuild`. Reuse `evaluateFeature` with `browser` skipped (`{ ok: true, errors: [], skipped: true }`) and `judgeFeature` on the resource's code window.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(boringstack): build driver"`.

---

### Task 7: Headless entry + live smoke

**Files:**
- Modify: `packages/core/scripts/headless-build.ts` (add a `TSFORGE_BORINGSTACK=1` branch)
- Test: manual live smoke (documented), plus `bun run validate` green.

**Interfaces:**
- Consumes: `runBoringstackBuild` (Task 6). The dir is a pre-scaffolded+booted BoringStack clone (from `tsforge scaffold --archetype boringstack`); `exec` is a real `Bun.spawn` adapter; `host` is the `Session`.

- [ ] **Step 1:** Add the branch: when `TSFORGE_BORINGSTACK=1`, build a real `Exec` (Bun.spawn), and call `runBoringstackBuild({ cwd: dir, goal: prompt, host: session, planner: provider, evaluator: provider, exec, report })`; print the checklist result; exit.
- [ ] **Step 2:** `bun run validate` → green (read real N pass/M fail).
- [ ] **Step 3: Commit** — `git commit -m "feat(boringstack): headless entry"`.
- [ ] **Step 4: Live smoke** — on the Phase-B clone (already booted), run one resource end-to-end with the local model; confirm ≥1 resource reaches BoringStack `validate` green, frozen, without touching other resources' files. Record turns-to-green.

---

### Task 8: Remove the legacy UI-only web scaffold

Only safe AFTER Task 7 (the boringstack loop is the live web-build path). The UI-only
scaffold that oscillated for two days is now dead weight, but it is still wired into
several consumers — so removal is a real, careful change, not a `git rm`.

**Files (remove / retarget):**
- Remove: `src/web-templates.ts`, `src/scaffold/web-scaffold.ts`, `src/web-routes.ts`,
  `src/web-components.ts`, `src/loop/tools/scaffold-web.ts`, `scaffold-ui.ts`,
  `scaffold-routes.ts`, `src/gate/web-gate.ts`, `src/loop/staged-build.ts` (web path),
  the `vite`/`--web` archetype in `cli/repl-scaffold.ts` + `cli/web-setup.ts`, and every
  test that exercises only those (`web-routes.test.ts`, `staged-build.test.ts`,
  `scaffold-routes-idempotent.test.ts`, `web-gate-tsconfig.test.ts`, etc.).
- Retarget or remove the tool registry entries (`agent.constants.ts`), `policy/classify.ts`,
  `conventions.ts` refs, and `loop/turn.ts` web-gating that reference the above.

**The one decision this task forces (ASK the human):** `self-harness/evaluate-web.ts`
builds its measurement corpus via `headless-build` → `scaffoldWeb`+`buildWebGate`. It must
either (a) RETARGET to boringstack builds (`runBoringstackBuild`), or (b) be REMOVED with
its web corpus. Do not guess — surface both to the human before deleting.

- [ ] **Step 1:** Enumerate the real consumer graph (`grep -rl` the removed symbols) and
  confirm nothing outside the list imports them.
- [ ] **Step 2:** Resolve the self-harness decision with the human (retarget vs remove).
- [ ] **Step 3:** Remove/retarget in dependency order; delete dead tests; keep the tool
  registry + policy coherent.
- [ ] **Step 4:** `bun run validate` green (read real N pass/M fail).
- [ ] **Step 5: Commit** — `git commit -m "refactor(boringstack): remove dead UI-only web scaffold"`.

---

## Deferred to follow-on plans (Scope Check decomposition)

- **C1 — BoringStack generator auto-wiring:** make `new:resource`/`new:feature` self-wire (routes/app/swagger) + emit passing test-sibling stubs, so Task 2's harness-side wiring becomes unnecessary and the generated slice is complete. (Also fixes the `createAuthMiddleware`→`requireAuth` class of drift at the source; that specific bug is already fixed uncommitted in the user's boringstack repo.)
- **C2 — Per-project port isolation:** env-parameterize BoringStack compose host ports + a tsforge port-allocator writing a unique free block per project + per-project `-p <name>`; unblocks concurrent multi-project builds. (See the spec's "Hard requirement — per-project port isolation".)
- **UI half hardening:** prove `new:feature` + `generate:api` + UI `validate` (build+size+knip) green by hand (Phase B did the API half only) before relying on it in the driver.

## Self-Review

- **Spec coverage:** driver (implement/evaluate/freeze) ✓ Task 6; generators+wiring+db:push ✓ Tasks 2-3; gate-in-full-repo-container ✓ Task 4; resource-based planning ✓ Task 1; division of labor ✓ Tasks 3+5; port-isolation + auto-wiring explicitly deferred ✓. Gap: the UI slice is only wired in `generateFeature` (Task 3) but not independently proven — flagged in Deferred.
- **Placeholder scan:** none — every task has concrete files, interfaces, and test code.
- **Type consistency:** `Exec`/`IExecResult` (Task 3) used identically in Tasks 3/4/6; `IGreenfieldDeps` shape matches `greenfield.types.ts`; `scopeFor`/`generateResource`/`runBoringstackGate` names consistent across tasks.
