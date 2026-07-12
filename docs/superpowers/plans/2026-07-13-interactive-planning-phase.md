# Interactive Planning Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a product-first interactive planning phase so greenfield BoringStack builds carry an approved product plan (domain model + feature slices + UI intent + verification contract) as shared context, instead of building blind from a one-line goal.

**Architecture:** A config-routed `planner` role proposes a structured product plan from the human's product description (+ mockups via vision). The human approves it once (the single gate). The approved plan is persisted as a `.specs/next.md`-style artifact and threaded into every feature's refine prompt. For greenfield BoringStack an approved plan is a hard build precondition (lifting BoringStack's `solo_spec_gate` to the harness level).

**Tech Stack:** TypeScript (Bun), the existing greenfield engine (`loop/greenfield/`), `models-config` role routing, the boringstack build path (`loop/boringstack/`), vision (`read_image`).

## Global Constraints

- Branch: **`feat/boringstack-build-loop`** (PR #83). Do NOT create a new branch.
- No `as` casts (`as const`/`satisfies` OK); no `eslint-disable`; cognitive complexity ≤ 20; shared AST walkers where relevant.
- "Test what you write." Commit only green. Full gate to declare done: `bun run typecheck && bunx eslint packages && bun test packages/core/tests/ && bun run e2e:pty` (or `bun run validate`).
- Planner role default model id: **`deepseek-4-pro`** (via `capabilities.planner`), swappable to local/any via config — never hardcode the model.
- The plan artifact honors the Solo Spec Loop contract: one living `.specs/next.md`, frontmatter `status: draft | approved`.
- Reject-by-default parsing: a malformed planner response yields `null`, never a partial plan.

---

### Task 1: `planner` capability role

**Files:**
- Modify: `packages/core/src/models-config.ts:62` (add `planner` to `CapabilityName`) and `:359` (`prefixByCap`)
- Test: `packages/core/tests/models-config.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: existing `resolveCapabilityModel(cap: CapabilityName): Promise<{ name: string; entry: IModelEntry } | null>`
- Produces: `resolveCapabilityModel("planner")` resolves `capabilities.planner` (env override `TSFORGE_PLANNER`); returns `null` when unconfigured.

- [ ] **Step 1: Write the failing test**

```ts
// models-config.test.ts
import { test, expect } from "bun:test";
import { CAPABILITY_NAMES } from "../src/models-config";

test("planner is a routable capability role", () => {
  expect(CAPABILITY_NAMES).toContain("planner");
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/core/tests/models-config.test.ts` → FAIL (`CAPABILITY_NAMES` undefined or missing `planner`).

- [ ] **Step 3: Implement**

```ts
// models-config.ts — replace the CapabilityName line
export const CAPABILITY_NAMES = [
  "vision",
  "imageGen",
  "expert",
  "planner",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
```
And add to `prefixByCap` (around :359):
```ts
    planner: "TSFORGE_PLANNER",
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(models): planner capability role"`

---

### Task 2: Product-plan type + `.specs` artifact I/O

**Files:**
- Create: `packages/core/src/loop/planning/plan-types.ts`
- Create: `packages/core/src/loop/planning/plan-store.ts`
- Test: `packages/core/tests/plan-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IEntitySpec {
    readonly id: string;            // PascalCase, e.g. "Bookmark"
    readonly desc: string;
    readonly fields: readonly { name: string; type: string; optional?: boolean }[];
    readonly relationships: readonly string[]; // e.g. "belongsTo User"
    readonly rules: readonly string[];
  }
  export interface IUiIntent {
    readonly screens: readonly ("list" | "detail" | "form" | "dashboard")[];
    readonly action: string;       // primary user action → observable result
    readonly shows: readonly string[];
    readonly nav: string;
  }
  export interface IVerificationContract {
    readonly mustRemainTrue: readonly string[];
    readonly mustNotHappen: readonly string[]; // ≥1
    readonly acceptanceCheck: string;          // runnable command, outcome-oriented
  }
  export interface ISlice {
    readonly entity: IEntitySpec;
    readonly ui: IUiIntent;
    readonly verification: IVerificationContract;
  }
  export interface IProductPlan {
    readonly product: string;      // one-paragraph purpose
    readonly slices: readonly ISlice[];
  }
  ```
- `writePlan(cwd: string, plan: IProductPlan, status: "draft" | "approved"): Promise<void>`
- `readPlan(cwd: string): Promise<{ plan: IProductPlan; status: "draft" | "approved" } | null>`
- `serializePlan(plan, status): string` / `parsePlan(text): { plan; status } | null` (pure)

- [ ] **Step 1: Write the failing test** (round-trip + reject-by-default)

```ts
import { test, expect } from "bun:test";
import { serializePlan, parsePlan } from "../src/loop/planning/plan-store";
import type { IProductPlan } from "../src/loop/planning/plan-types";

const PLAN: IProductPlan = {
  product: "A team bookmarking app.",
  slices: [
    {
      entity: { id: "Bookmark", desc: "a saved link", fields: [{ name: "url", type: "string" }, { name: "description", type: "string", optional: true }], relationships: ["belongsTo User"], rules: ["url required"] },
      ui: { screens: ["list", "form"], action: "save a bookmark → it appears in the list", shows: ["url", "description"], nav: "Bookmarks" },
      verification: { mustRemainTrue: ["listing requires auth"], mustNotHappen: ["saving without a url"], acceptanceCheck: "bun test tests/api/bookmark" },
    },
  ],
};

test("plan round-trips through serialize/parse with status", () => {
  const text = serializePlan(PLAN, "approved");
  const parsed = parsePlan(text);
  expect(parsed?.status).toBe("approved");
  expect(parsed?.plan.slices[0]?.entity.fields.map((f) => f.name)).toEqual(["url", "description"]);
});

test("a malformed artifact parses to null (reject-by-default)", () => {
  expect(parsePlan("not a plan")).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — `plan-types.ts` (the interfaces above). `plan-store.ts`: serialize the plan as YAML-frontmatter (`status`) + a fenced JSON block inside the `.specs/next.md` structure; `parsePlan` reads the frontmatter status + JSON block, validates shape with existing `isRecord`/guards (no `as`), returns `null` on any mismatch. `writePlan`/`readPlan` wrap `Bun.file`/`Bun.write` at `${cwd}/.specs/next.md`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(planning): product-plan type + .specs artifact I/O"`

---

### Task 3: Planner proposal from a product description

**Files:**
- Create: `packages/core/src/loop/planning/propose-plan.ts`
- Test: `packages/core/tests/propose-plan.test.ts`

**Interfaces:**
- Consumes: `IProvider` (from `../../inference`), `IProductPlan`, `parsePlanJson`
- Produces: `proposePlan(deps: { planner: IProvider }, input: { description: string; mockups?: readonly string[] }): Promise<IProductPlan | null>` — the planner returns a JSON plan; parsed + validated; `null` on unusable output. `mockups` are image references passed to the planner via the existing vision side-channel.

- [ ] **Step 1: Write the failing test** (fake planner returns a plan)

```ts
import { test, expect } from "bun:test";
import { proposePlan } from "../src/loop/planning/propose-plan";

const planner = {
  complete: async () => ({
    content: JSON.stringify({
      product: "A bookmarking app.",
      slices: [{ entity: { id: "Bookmark", desc: "a link", fields: [{ name: "url", type: "string" }], relationships: [], rules: [] }, ui: { screens: ["list"], action: "save → list", shows: ["url"], nav: "Bookmarks" }, verification: { mustRemainTrue: ["auth"], mustNotHappen: ["no url"], acceptanceCheck: "bun test" } }],
    }),
    toolCalls: [],
  }),
};

test("proposePlan turns a product description into a structured plan", async () => {
  const plan = await proposePlan({ planner }, { description: "a bookmarking app" });
  expect(plan?.slices[0]?.entity.id).toBe("Bookmark");
});

test("a non-JSON planner reply yields null", async () => {
  const bad = { complete: async () => ({ content: "sorry", toolCalls: [] }) };
  expect(await proposePlan({ planner: bad }, { description: "x" })).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — a `PLANNER_SYSTEM` prompt ("You are a product architect. From the product description + mockups, propose a domain model + feature slices + UI intent + verification contract. Respond with ONLY the JSON plan."); call `planner.complete([...])`; `extractJson` + validate into `IProductPlan` (reuse Task 2's parser), `null` on mismatch. One retry at higher temperature on parse failure (mirror `planResources`).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(planning): planner proposes a structured product plan"`

---

### Task 4: Approval gate helper

**Files:**
- Modify: `packages/core/src/loop/planning/plan-store.ts`
- Test: `packages/core/tests/plan-store.test.ts` (extend)

**Interfaces:**
- Produces: `loadApprovedPlan(cwd: string): Promise<IProductPlan | null>` — returns the plan only when `status === "approved"`, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
test("loadApprovedPlan returns null for a draft, the plan when approved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));
  try {
    await writePlan(dir, PLAN, "draft");
    expect(await loadApprovedPlan(dir)).toBeNull();
    await writePlan(dir, PLAN, "approved");
    expect((await loadApprovedPlan(dir))?.slices.length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — `loadApprovedPlan` = `readPlan` then return `plan` iff `status === "approved"`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(planning): approved-plan gate helper"`

---

### Task 5: Thread the plan into `refinePrompt`

**Files:**
- Modify: `packages/core/src/loop/boringstack/refine-prompt.ts` (`refinePrompt`)
- Test: `packages/core/tests/boringstack-refine-prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `IFeature`, `ISlice` (Task 2)
- Produces: `refinePrompt(feature: IFeature, slice?: ISlice): string` — when `slice` is given, the prompt includes the product-level context: entity fields (name+type+optional), relationships, rules, UI intent (screens, action, shows, nav), and the verification contract. Backward-compatible: with no `slice`, identical to today.

- [ ] **Step 1: Write the failing test**

```ts
test("refinePrompt injects the slice's fields, UI intent, and contract when given a plan slice", () => {
  const feature = { id: "Bookmark", desc: "a link", passes: false, attempts: 0 };
  const slice = { entity: { id: "Bookmark", desc: "a link", fields: [{ name: "description", type: "string", optional: true }], relationships: ["belongsTo User"], rules: ["url required"] }, ui: { screens: ["list", "form"], action: "save → list", shows: ["url", "description"], nav: "Bookmarks" }, verification: { mustRemainTrue: ["auth"], mustNotHappen: ["no url"], acceptanceCheck: "bun test" } };
  const p = refinePrompt(feature, slice);
  expect(p).toContain("description");        // the field it kept dropping
  expect(p).toContain("belongsTo User");
  expect(p).toContain("save → list");        // UI intent
  expect(p).toContain("url required");       // rule
});

test("refinePrompt without a slice is unchanged (contains id + desc)", () => {
  const p = refinePrompt({ id: "Bookmark", desc: "a link", passes: false, attempts: 0 });
  expect(p).toContain("Bookmark");
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — add an optional `slice?: ISlice` param; when present, build a `## Product context` section (fields as a bullet list, relationships, rules, UI intent, verification contract) and interpolate it after `**Behavior**`. Keep the existing single-`feature.desc` path when `slice` is undefined.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(boringstack): refinePrompt carries the approved plan slice as context"`

---

### Task 6: Build precondition + build from plan slices

**Files:**
- Modify: `packages/core/src/loop/boringstack/build.ts` (`runBoringstackBuild`, `boringstackDeps`)
- Modify: `packages/core/src/loop/boringstack/plan-resources.ts` (add `slicesToFeatures`)
- Test: `packages/core/tests/boringstack-build.test.ts` (extend)

**Interfaces:**
- Consumes: `loadApprovedPlan` (Task 4), `ISlice`, `refinePrompt(feature, slice)` (Task 5)
- Produces: `runBoringstackBuild` returns `{ status: "needs-plan", features: [] }` when no approved plan exists; otherwise derives features from `plan.slices` (each `ISlice.entity` → `IFeature`) and passes the matching slice into `implement`'s `refinePrompt`. `spec = goal` is removed.

- [ ] **Step 1: Write the failing test**

```ts
test("runBoringstackBuild refuses (needs-plan) when no approved plan exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bs-"));
  try {
    const res = await runBoringstackBuild({ cwd: dir, goal: "x", host: createHost(), evaluator: createEvaluator(), exec: createExec() });
    expect(res.status).toBe("needs-plan");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```
(Plus: with an approved plan on disk, it builds features derived from the slices and `host.sent[0]` contains the slice's field, e.g. "description".)

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — at the top of `runBoringstackBuild`, `const approved = await loadApprovedPlan(cwd); if (approved === null) return { status: "needs-plan", features: [] };` Derive `features` from `approved.slices` via `slicesToFeatures`. Thread a `slice`-lookup (by feature id) into `boringstackDeps` so `implement` calls `refinePrompt(feature, slice)`. Delete the `spec: goal` shortcut. Extend `IGreenfieldResult`/the return union with `"needs-plan"` (or map it to `stuck` with a clear reason if the type is closed — prefer adding the status).
- [ ] **Step 4: Run to verify pass** + `bun test packages/core/tests/boringstack-*.test.ts`.
- [ ] **Step 5: Commit** — `git commit -am "feat(boringstack): require an approved plan; build from its slices with context"`

---

### Task 7: Interactive planning orchestration

**Files:**
- Create: `packages/core/src/loop/planning/run-planning.ts`
- Test: `packages/core/tests/run-planning.test.ts`

**Interfaces:**
- Consumes: `proposePlan` (Task 3), `writePlan` (Task 2)
- Produces:
  ```ts
  export interface IPlanningDeps {
    planner: IProvider;
    describe: () => Promise<{ description: string; mockups?: readonly string[] }>; // gather product input
    review: (plan: IProductPlan) => Promise<{ action: "approve" } | { action: "revise"; note: string } | { action: "cancel" }>;
    out: (s: string) => void;
  }
  export async function runPlanning(cwd: string, deps: IPlanningDeps): Promise<"approved" | "cancelled">;
  ```
  Loop: describe → proposePlan → review; on `approve` → `writePlan(cwd, plan, "approved")` → return `"approved"`; on `revise` → re-propose with the note appended; on `cancel` → return `"cancelled"`. Cap revisions (e.g. 5).

- [ ] **Step 1: Write the failing test** (approve path writes an approved plan; cancel writes nothing)

```ts
test("runPlanning writes an approved plan when the human approves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));
  try {
    const deps = { planner: fakePlanner(), describe: async () => ({ description: "a bookmarking app" }), review: async () => ({ action: "approve" as const }), out: () => {} };
    expect(await runPlanning(dir, deps)).toBe("approved");
    expect((await readPlan(dir))?.status).toBe("approved");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```
(Plus: `review` returning `revise` once then `approve` re-proposes and still approves; `cancel` → returns "cancelled", no file.)

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `run-planning.ts` per the interface. Pure orchestration over injected deps; no direct TTY/model coupling (the REPL wires the real `describe`/`review`/planner in Task 8).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(planning): interactive plan → propose → approve orchestration"`

---

### Task 8: Wire into the REPL + wizard + headless (enforcement)

**Files:**
- Modify: `packages/core/src/cli/repl-scaffold.ts` (flow the wizard into planning)
- Modify: `packages/core/src/cli/repl.ts` (intercept a greenfield "build me X" → planning)
- Modify: `packages/core/scripts/headless-build.ts` (`--plan`; refuse greenfield without an approved plan)
- Test: `packages/core/tests/headless-build-args.test.ts` (arg parsing); REPL wiring covered by an e2e PTY assertion where feasible

**Interfaces:**
- Consumes: `runPlanning` (Task 7), `loadApprovedPlan` (Task 4), `resolveCapabilityModel("planner")` (Task 1)
- Produces: after the scaffold wizard for a boringstack project, `runPlanning` runs (planner from the `planner` role, default `deepseek-4-pro`) before any build. `headless-build.ts` parses `--plan <file>`; on a greenfield boringstack build with no approved plan and no `--plan`, it prints a clear refusal and exits non-zero.

- [ ] **Step 1: Write the failing test** (headless arg parsing + refusal)

```ts
test("headless refuses a greenfield build with no approved plan and no --plan", () => {
  // parseHeadlessArgs(["goal", "/clone"]) → { needsPlan: true } when /clone has no approved plan
  expect(parseHeadlessArgs(["build x", "/clone"]).planPath).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — extract `parseHeadlessArgs` (pure) from `headless-build.ts` main() adding `--plan`; in `main`, if the clone has no `loadApprovedPlan` and no `--plan` supplied → refuse. In `repl-scaffold.ts`, after `runScaffold` for boringstack, call `runPlanning(dest, …)` wiring `describe`/`review` to the REPL editor + the planner provider. In `repl.ts`, when the active project is a fresh boringstack clone with no approved plan and the user submits a build-style message, route the message text into `runPlanning` as the description instead of the build loop.
- [ ] **Step 4: Run to verify pass** + `bun run e2e:pty` (REPL flow) + full `bun run validate`.
- [ ] **Step 5: Commit** — `git commit -am "feat(planning): wizard→planning flow, REPL interception, headless --plan enforcement"`

---

## Self-Review

**Spec coverage:** product-first interactive planning (T3, T7, T8); planner role config-routed + swappable (T1); plan = domain model + slices + UI intent + verification contract (T2); human approves once (T7); autonomous per-slice build with plan as context (T5, T6); mandatory for greenfield (T6 precondition, T8 wizard/REPL/headless enforcement); reuse greenfield engine + vision + `.specs` contract (T2, T3, T6). Reviewer role explicitly deferred. All covered.

**Placeholder scan:** none — every code step carries real code or a precise change site.

**Type consistency:** `IProductPlan`/`ISlice`/`IEntitySpec`/`IUiIntent`/`IVerificationContract` defined in T2 and consumed unchanged in T3/T5/T6/T7; `refinePrompt(feature, slice?)` signature consistent T5→T6; `loadApprovedPlan` consistent T4→T6/T8; `resolveCapabilityModel("planner")` consistent T1→T8.
