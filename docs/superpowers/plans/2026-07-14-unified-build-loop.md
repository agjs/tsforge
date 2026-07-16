# Unified Build Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the escalation ladder fire for every build mode by feeding each mode's REAL gate into the ONE seam both loop drivers already share (`settleGate`), instead of running the real gate outside the loop.

**Architecture:** Both loop drivers (`runTask` in `loop/run.ts`, `Session` in `loop/session.ts`) already call the same `settleGate` → `checkStuck` → `tryExpertRescue` primitives in `loop/turn.ts`. Today boringstack/greenfield run the model against a *gateless* (or TS-only) gate and run the authoritative gate (differential lint + judge + reachability) in a *separate* `evaluate` step outside the loop — so `checkStuck` never sees the real errors and can't escalate. This plan generalizes the loop's gate from a hardcoded `--accept` shell string into an injected, composable `IGate` object, gives each mode its real composed gate, deletes the `implement`/`evaluate` split and the greenfield-level escalation band-aids, and proves the ladder now fires on lint/judge failures.

**Tech Stack:** TypeScript (strict), Bun test runner, ESLint strict config. No new dependencies.

## Global Constraints

- **Brownfield `--accept` behavior MUST stay identical.** The default `IGate` is exactly today's `validate(task, …)`. The existing test suite is the regression anchor — it must stay green with no assertion changes.
- **Never relax the gate.** No downgrading rule severities/thresholds. No `as` casts, no `eslint-disable`, no `@ts-ignore`, no non-null `!`. Cognitive complexity ≤ 20 — achieve by extracting helpers, never by raising the cap.
- **Do not merge the two drivers.** `runTask` and `Session` both stay. `Session` keeps its long-run features (auto-compaction, per-write lint, incremental check, adaptive thinking). The unification is the gate seam, not the driver.
- **Every stage failure is an `IErrorItem`** (`{ key: string; file?: string; line?: number; rule?: string; message: string }`) so `checkStuck`'s fingerprint/progress guards work uniformly.
- **All code paths run under `bun run validate`** (tsc strict + eslint strict + tests). Read the REAL `N pass / M fail` line from the output tail — never trust a piped exit code alone (it has misreported this session).
- **Absolute file paths** in any human-facing note.

---

## File Structure

**Create:**
- `packages/core/src/gate/gate-runner.ts` — the generic gate seam: `IGate`, `IStage`, `IGateRunOpts`, `composeGate`, `commandGate`, `differentialStage`.
- `packages/core/src/loop/boringstack/gate-stages.ts` — boringstack's mode-specific stages (`boringstackCommandStage`, `reachabilityStage`, `judgeStage`) + `composeBoringstackGate`.
- `packages/core/tests/gate-runner.test.ts` — unit tests for the generic seam.
- `packages/core/tests/boringstack-gate-stages.test.ts` — unit tests for the boringstack stages.

**Modify:**
- `packages/core/src/gate/types.ts` — rename `IGate` (the `{command,label}` descriptor) → `IGateSpec`.
- `packages/core/src/loop/turn.ts` — `ILoopCtxGate` gains `runner`; `runGateStep` calls `ctx.gate.runner.run(cwd, …)`.
- `packages/core/src/loop/run.ts` — build `ctx.gate.runner` from `opts.gate ?? commandGate(task, parse)`.
- `packages/core/src/loop/loop.types.ts` — `IRunOptions` gains `gate?: IGate`.
- `packages/core/src/loop/session.ts` — `ISessionConfig` gains `gate?: IGate`; `Session` gains `setGate`; ctx.gate.runner built from it.
- `packages/core/src/loop/greenfield/greenfield.types.ts` — `IGreenfieldDeps` loses `evaluate`/`rescue`; `implement` returns `{ done: boolean; handoff?: IHandoff }`.
- `packages/core/src/loop/greenfield/run.ts` — delete `escalateGuidance`, `EVAL_STALL_BACKSTOP`, the evaluate/rescue retry; `attemptFeature` ticks on `done`, parks on `handoff`.
- `packages/core/src/loop/boringstack/build.ts` — `IBoringstackHost` gains `setGate`; `implement` becomes pre-step + send with a live per-feature gate; delete `evaluate` + `rescue`.
- `packages/core/scripts/headless-build.ts` — Session created supporting `setGate`.
- `packages/core/src/cli.ts` — `greenfieldDeps` passes a composed gate to `runTask`; drop `requireRed:false` + evaluate + rescue.
- Astro docs (Task 10).

**Delete:**
- `packages/core/src/loop/greenfield/evaluate.ts` (its layered logic becomes composed stages).

**Reuse unchanged:** `validate/validate.ts`, `validate/accept.ts`, `boringstack/gate.ts` (`runBoringstackGate`), `boringstack/extract-failures.ts`, `boringstack/reachability.ts` (`verifyFeatureReachable`), `greenfield/judge.ts` (`judgeFeature`), `boringstack/build.ts` helpers (`autofixApps`, `readResourceCode`, `rescueFileFor`, `scopeFor`).

---

## Phase 1 — The generic gate seam

### Task 1: `IGate` / `IStage` / `composeGate` / `commandGate` / `differentialStage`

**Files:**
- Create: `packages/core/src/gate/gate-runner.ts`
- Test: `packages/core/tests/gate-runner.test.ts`

**Interfaces:**
- Consumes: `IValidateResult` and `IErrorItem` from `packages/core/src/validate` (`export interface IErrorItem { key: string; file?: string; line?: number; rule?: string; message: string }`; `validate(task, cwd, parse?, opts?): Promise<IValidateResult>` where `IValidateResult = { passed: boolean; errors: IErrorItem[]; output: string }`); `ITask` from `packages/core/src/spec/spec.types`; `ErrorParser` from `packages/core/src/validate`.
- Produces:
  - `IGateRunOpts { onChunk?: (t: string) => void; signal?: AbortSignal }`
  - `IStage { run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult> }`
  - `IGate { run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult> }`
  - `composeGate(stages: IStage[]): IGate`
  - `commandGate(task: ITask, parse?: ErrorParser): IGate`
  - `differentialStage(inner: IStage, baseline: ReadonlySet<string>): IStage`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/gate-runner.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import {
  composeGate,
  differentialStage,
  type IStage,
} from "../src/gate/gate-runner";
import type { IValidateResult } from "../src/validate";

const green: IStage = {
  run: async () => ({ passed: true, errors: [], output: "ok" }),
};

const redWith = (keys: string[]): IStage => ({
  run: async (): Promise<IValidateResult> => ({
    passed: false,
    errors: keys.map((k) => ({ key: k, message: k })),
    output: keys.join("\n"),
  }),
});

describe("composeGate", () => {
  test("all stages green → passed, no errors", async () => {
    const gate = composeGate([green, green]);
    const r = await gate.run("/tmp");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("stops at the FIRST failing stage (short-circuit)", async () => {
    let secondRan = false;
    const spy: IStage = {
      run: async () => {
        secondRan = true;

        return { passed: false, errors: [{ key: "b", message: "b" }], output: "b" };
      },
    };
    const gate = composeGate([redWith(["a"]), spy]);
    const r = await gate.run("/tmp");

    expect(r.passed).toBe(false);
    expect(r.errors.map((e) => e.key)).toEqual(["a"]);
    expect(secondRan).toBe(false);
  });

  test("empty stage list → green", async () => {
    const r = await composeGate([]).run("/tmp");

    expect(r.passed).toBe(true);
  });
});

describe("differentialStage", () => {
  test("suppresses baseline failures, surfaces only NEW ones", async () => {
    const stage = differentialStage(redWith(["base1", "new1"]), new Set(["base1"]));
    const r = await stage.run("/tmp");

    expect(r.passed).toBe(false);
    expect(r.errors.map((e) => e.key)).toEqual(["new1"]);
  });

  test("all failures are baseline → passes (feature introduced nothing new)", async () => {
    const stage = differentialStage(redWith(["base1", "base2"]), new Set(["base1", "base2"]));
    const r = await stage.run("/tmp");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("inner green → passes through green", async () => {
    const stage = differentialStage(green, new Set(["base1"]));

    expect((await stage.run("/tmp")).passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && bun test tests/gate-runner.test.ts`
Expected: FAIL — `Cannot find module '../src/gate/gate-runner'`.

- [ ] **Step 3: Implement `gate-runner.ts`**

Create `packages/core/src/gate/gate-runner.ts`:

```typescript
import type { ITask } from "../spec/spec.types";
import { validate } from "../validate";
import type { ErrorParser, IValidateResult } from "../validate";

/** Per-run hooks a gate/stage forwards to the underlying command runner. */
export interface IGateRunOpts {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * One check contributing to a gate. Returns the standard validate shape so its
 * failures are `IErrorItem`s the loop's `checkStuck` can fingerprint and escalate
 * on — the whole point of composing the REAL gate inside the loop.
 */
export interface IStage {
  run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult>;
}

/**
 * The gate the loop runs each cycle. Injected into `settleGate` (via
 * `ctx.gate.runner`), replacing the hardcoded `--accept` shell. The default gate
 * (`commandGate`) is exactly today's `validate`, so brownfield is unchanged.
 */
export interface IGate {
  run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult>;
}

/**
 * Compose stages into one gate, run in series and SHORT-CIRCUITED: stages run
 * cheapest-first and the gate stops at the first failure, returning that stage's
 * result. So expensive stages (judge = a model call, browser = Playwright) run
 * ONLY when every cheaper stage is already green — a stalled unit that can't pass
 * the command stage never pays for a judge call.
 */
export function composeGate(stages: IStage[]): IGate {
  return {
    async run(cwd: string, opts?: IGateRunOpts): Promise<IValidateResult> {
      const outputs: string[] = [];

      for (const stage of stages) {
        const r = await stage.run(cwd, opts);

        outputs.push(r.output);

        if (!r.passed) {
          return { passed: false, errors: r.errors, output: outputs.join("\n") };
        }
      }

      return { passed: true, errors: [], output: outputs.join("\n") };
    },
  };
}

/** The default gate: run the task's `--accept` command and parse it. Identical to
 *  today's loop behavior — the brownfield regression anchor. */
export function commandGate(task: ITask, parse?: ErrorParser): IGate {
  return {
    run: (cwd, opts) => validate(task, cwd, parse, opts ?? {}),
  };
}

/**
 * Wrap a stage so pre-existing BASELINE failures are suppressed and only NEW ones
 * surface. `baseline` is a set of failure-signature keys captured once at build
 * start; it lives in this closure, NOT in the task/ctx. When every current failure
 * is a baseline failure the feature introduced nothing broken → the wrapped stage
 * passes. This is boringstack's differential grading, generalized.
 */
export function differentialStage(
  inner: IStage,
  baseline: ReadonlySet<string>
): IStage {
  return {
    async run(cwd, opts): Promise<IValidateResult> {
      const r = await inner.run(cwd, opts);

      if (r.passed) {
        return r;
      }

      const novel = r.errors.filter((e) => !baseline.has(e.key));

      if (novel.length === 0) {
        return {
          passed: true,
          errors: [],
          output:
            `gate red, but all ${String(r.errors.length)} failure(s) are ` +
            `pre-existing baseline failures the feature cannot touch.`,
        };
      }

      const hidden = r.errors.length - novel.length;
      const note =
        hidden > 0 ? ` (${String(hidden)} baseline failure(s) hidden)` : "";

      return {
        passed: false,
        errors: novel,
        output: `NEW failures introduced by this feature${note}:\n${r.output}`,
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && bun test tests/gate-runner.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Confirm `validate` re-exports the types used**

Run: `cd packages/core && grep -n "IValidateResult\|ErrorParser\|IErrorItem" src/validate/index.ts`
Expected: all three are exported from the `validate` barrel. If `IValidateResult` is not exported there, add `export type { IValidateResult } from "./validate.types";` to `packages/core/src/validate/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/gate/gate-runner.ts packages/core/tests/gate-runner.test.ts packages/core/src/validate/index.ts
git commit -m "feat(gate): composable IGate/IStage seam (composeGate, commandGate, differentialStage)"
```

---

## Phase 2 — Wire the seam into both drivers (brownfield-invariant)

### Task 2: Rename the descriptor `IGate` → `IGateSpec`, wire `runner` into `runTask`

**Files:**
- Modify: `packages/core/src/gate/types.ts` (rename `IGate` → `IGateSpec`)
- Modify: `packages/core/src/loop/loop.types.ts` (`IRunOptions.gate?`)
- Modify: `packages/core/src/loop/turn.ts` (`ILoopCtxGate.runner`; `runGateStep`)
- Modify: `packages/core/src/loop/run.ts` (build `ctx.gate.runner`)

**Interfaces:**
- Consumes: `IGate`, `commandGate` from `packages/core/src/gate/gate-runner` (Task 1).
- Produces: `IRunOptions.gate?: IGate`; `ILoopCtxGate.runner: IGate`.

- [ ] **Step 1: Rename the descriptor type to free the name `IGate`**

Find every reference to the OLD `IGate` (the `{ command; label }` descriptor in `gate/types.ts`):

Run: `cd packages/core && grep -rn "\bIGate\b" src | grep -v gate-runner`
For each hit that refers to the `{command,label}` descriptor, rename it to `IGateSpec`. In `packages/core/src/gate/types.ts` change:

```typescript
export interface IGateSpec {
  /** The shell command run to verify (must exit 0). */
  command: string;
  /** A short human label for the banner. */
  label: string;
}
```

Update all importers accordingly (the grep list). Do NOT touch `gate-runner.ts`'s new `IGate`.

- [ ] **Step 2: Run typecheck to confirm the rename is complete**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | tail -30`
Expected: no `IGate` errors (any remaining `Cannot find name 'IGate'` means a descriptor importer was missed — fix it). It is fine if new `IGate` (the runner) is not yet used.

- [ ] **Step 3: Add `gate?` to `IRunOptions`**

In `packages/core/src/loop/loop.types.ts`, add to `IRunOptions` (after `profile?`):

```typescript
  /** The composed gate this run's loop checks each cycle. Defaults to a command
   *  gate built from `task.accept` (brownfield behavior). Modes inject a richer
   *  composed gate (command + differential + judge + …) so the escalation ladder
   *  sees the REAL errors. */
  gate?: import("../gate/gate-runner").IGate;
```

- [ ] **Step 4: Add `runner` to `ILoopCtxGate` and use it in `runGateStep`**

In `packages/core/src/loop/turn.ts`, add to `ILoopCtxGate` (interface near line 261):

```typescript
  /** The composed gate the loop runs each cycle. Always set by the driver
   *  (runTask/Session) — defaults to a command gate from task.accept. */
  runner: import("../gate/gate-runner").IGate;
```

Then change `runGateStep` (near line 1017) so it calls the injected runner instead of `validate` directly:

```typescript
async function runGateStep(
  ctx: ILoopCtx,
  turn: number
): Promise<Awaited<ReturnType<typeof validate>>> {
  const { task, report } = ctx;

  if (ctx.gate.onGateChunk !== undefined) {
    report({
      kind: "tool",
      task: task.id,
      message: `⚙ running gate · turn ${turn}…`,
    });
  }

  const gate = await ctx.gate.runner.run(ctx.cwd, {
    ...(ctx.gate.onGateChunk === undefined
      ? {}
      : { onChunk: ctx.gate.onGateChunk }),
    ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
  });

  ctx.gate.onGateChunk?.flush?.();

  return gate;
}
```

(The return type is unchanged — `commandGate`'s result is the same `IValidateResult` `validate` returns.)

- [ ] **Step 5: Build `ctx.gate.runner` in `run.ts`**

In `packages/core/src/loop/run.ts`, where `ctx.gate` is constructed (the object with `parse`/`lintFile`/etc.), set `runner`. Import at top: `import { commandGate } from "../gate/gate-runner";`. At the ctx.gate construction site add:

```typescript
    runner: opts.gate ?? commandGate(task, effectiveParse),
```

Use the same `effectiveParse` value already computed for `redPrecheck` (near line 903). If `redPrecheck` runs the gate directly via `validate`, leave it as-is for now (its default path is identical); this task only routes the per-turn gate through the runner.

- [ ] **Step 6: Run the full brownfield regression suite — the anchor**

Run: `cd packages/core && bun test 2>&1 | tail -20`
Expected: same pass count as before this task, zero new failures. Brownfield behavior is byte-identical because the default `runner` is `commandGate` = `validate`. If any loop test fails, the `runner` default or `runGateStep` wiring is wrong — fix before proceeding.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/gate/types.ts packages/core/src/loop/loop.types.ts packages/core/src/loop/turn.ts packages/core/src/loop/run.ts
git commit -m "feat(loop): route settleGate through injected IGate.runner (default = command gate); rename descriptor IGate→IGateSpec"
```

### Task 3: Wire the gate seam into `Session` + add `setGate`

**Files:**
- Modify: `packages/core/src/loop/session.ts`

**Interfaces:**
- Consumes: `IGate`, `commandGate` from `gate/gate-runner`.
- Produces: `ISessionConfig.gate?: IGate`; `Session.setGate(gate: IGate): void`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/tests/session.test.ts` (or create `packages/core/tests/session-gate.test.ts` if the former is unwieldy):

```typescript
import { test, expect } from "bun:test";
import { Session } from "../src/loop/session";
import type { IGate } from "../src/gate/gate-runner";

test("Session.setGate flips hasGate on and routes the gate through the loop", async () => {
  const provider = {
    complete: async () => ({ content: "", toolCalls: [] }),
  };
  // A gate that fails once then passes, proving the loop calls the injected runner.
  let calls = 0;
  const gate: IGate = {
    run: async () => {
      calls += 1;

      return calls === 1
        ? { passed: false, errors: [{ key: "x", message: "x" }], output: "x" }
        : { passed: true, errors: [], output: "ok" };
    },
  };
  const session = await Session.create({
    provider: provider as never,
    cwd: "/tmp",
    files: ["**/*"],
  });

  session.setGate(gate);
  // hasGate must now be true so the loop runs the gate at yield.
  expect(session.hasGateForTest?.() ?? true).toBe(true);
});
```

If `Session` has no test-visible `hasGate` accessor, assert indirectly: after `setGate`, a no-tool-call send triggers `gate.run` (spy on `calls > 0`). Prefer the indirect assertion — do not add production accessors solely for the test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test tests/session-gate.test.ts`
Expected: FAIL — `session.setGate is not a function`.

- [ ] **Step 3: Add `gate?` to `ISessionConfig` and build the runner**

In `packages/core/src/loop/session.ts`, add to `ISessionConfig` (near line 73):

```typescript
  /** Composed gate the session's loop checks each cycle. Defaults to a command
   *  gate from `accept`. Use `setGate` to swap it per unit mid-build. */
  gate?: import("../gate/gate-runner").IGate;
```

Import `commandGate` at top. Where `Session.create` builds the ctx.gate object, set:

```typescript
    runner: cfg.gate ?? commandGate(task, cfg.parse),
```

And set `this.hasGate = cfg.gate !== undefined || (cfg.accept !== undefined && cfg.accept.length > 0);` — a session with an injected gate HAS a gate even when `accept` is empty (this is the exact bug that made boringstack gateless).

- [ ] **Step 4: Add `setGate`**

Add a method to the `Session` class:

```typescript
  /** Swap the composed gate mid-build (one per unit/feature). Flips hasGate on so
   *  the loop actually runs it and the escalation ladder sees its failures. */
  setGate(gate: IGate): void {
    this.ctx.gate.runner = gate;
    this.hasGate = true;
  }
```

Import the `IGate` type. Ensure `this.ctx` and `this.hasGate` are the fields the loop reads (they are — `hasGate` at session.ts:520, ctx.gate consumed by `runGateStep`).

- [ ] **Step 5: Run the test + full suite**

Run: `cd packages/core && bun test tests/session-gate.test.ts && bun test 2>&1 | tail -15`
Expected: new test PASS; full suite pass count unchanged otherwise.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/loop/session.ts packages/core/tests/session-gate.test.ts
git commit -m "feat(session): inject composed IGate + setGate; a gate-bearing session is never gateless"
```

---

## Phase 3 — Boringstack stages

### Task 4: Boringstack gate stages + composition

**Files:**
- Create: `packages/core/src/loop/boringstack/gate-stages.ts`
- Test: `packages/core/tests/boringstack-gate-stages.test.ts`

**Interfaces:**
- Consumes: `IStage`, `IGate`, `composeGate`, `differentialStage` from `gate/gate-runner`; `Exec` from `./exec` (`type Exec = (argv: readonly string[], opts: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }>`); `runBoringstackGate(cwd, exec): Promise<{ passed; output }>` from `./gate`; `extractFailures(output, cwd): Set<string>` and `novelFailures` from `./extract-failures`; `verifyFeatureReachable(cwd, id): Promise<{ ok: boolean; problems: readonly string[] }>` from `./reachability`; `judgeFeature(provider, { feature, code }): Promise<{ ok: boolean; notes: string }>` from `../greenfield/judge`; `readResourceCode(cwd, name)`, `rescueFileFor(cwd, feature)`, `autofixApps(cwd, exec)` from `./build` (export the currently-private `autofixApps`); `IFeature` from `../greenfield/greenfield.types`; `IProvider` from `../../inference`.
- Produces:
  - `boringstackCommandStage(cwd: string, exec: Exec): IStage`
  - `reachabilityStage(cwd: string, featureId: string): IStage`
  - `judgeStage(evaluator: IProvider, cwd: string, feature: IFeature): IStage`
  - `composeBoringstackGate(opts: { cwd: string; exec: Exec; evaluator: IProvider; baseline: ReadonlySet<string>; feature: IFeature }): IGate`

- [ ] **Step 1: Export `autofixApps` from `build.ts`**

In `packages/core/src/loop/boringstack/build.ts`, change `async function autofixApps` to `export async function autofixApps`.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/tests/boringstack-gate-stages.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import {
  boringstackCommandStage,
  reachabilityStage,
  judgeStage,
} from "../src/loop/boringstack/gate-stages";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";

const feature: IFeature = { id: "note", desc: "a note", passes: false, attempts: 0 };

const execWith = (code: number, stdout: string): Exec =>
  async () => ({ code, stdout, stderr: "" });

describe("boringstackCommandStage", () => {
  test("green gate → passed, no errors", async () => {
    const stage = boringstackCommandStage("/tmp/clone", execWith(0, "all good"));
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("red gate → each failure signature becomes an IErrorItem (key = signature)", async () => {
    const out = "1:1 error Unexpected  no-console\nerror TS2322: bad";
    const stage = boringstackCommandStage("/tmp/clone", execWith(1, out));
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    // Every error carries a stable key so checkStuck can fingerprint it and the
    // differential wrapper can suppress baseline signatures.
    for (const e of r.errors) {
      expect(typeof e.key).toBe("string");
      expect(e.key.length).toBeGreaterThan(0);
    }
  });
});

describe("judgeStage", () => {
  test("judge rejects → one IErrorItem with rule 'judge' and a resolvable file", async () => {
    const evaluator = {
      complete: async () => ({ content: '{"pass":false,"notes":"stub only"}', toolCalls: [] }),
    };
    const stage = judgeStage(evaluator as never, "/tmp/clone", feature);
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.rule).toBe("judge");
    expect(r.errors[0]?.message).toContain("stub only");
  });

  test("judge passes → green", async () => {
    const evaluator = {
      complete: async () => ({ content: '{"pass":true,"notes":"good"}', toolCalls: [] }),
    };
    const stage = judgeStage(evaluator as never, "/tmp/clone", feature);

    expect((await stage.run("/tmp/clone")).passed).toBe(true);
  });
});
```

(The `as never` here is confined to TEST doubles for the `IProvider`, not production code — production must stay cast-free. If the house rule forbids `as` even in tests, construct a minimal object typed as `IProvider`.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd packages/core && bun test tests/boringstack-gate-stages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `gate-stages.ts`**

Create `packages/core/src/loop/boringstack/gate-stages.ts`:

```typescript
import { join } from "node:path";
import type { IGate, IStage } from "../../gate/gate-runner";
import { composeGate, differentialStage } from "../../gate/gate-runner";
import type { IValidateResult } from "../../validate";
import type { IProvider } from "../../inference";
import type { IFeature } from "../greenfield/greenfield.types";
import type { Exec } from "./exec";
import { runBoringstackGate } from "./gate";
import { extractFailures } from "./extract-failures";
import { verifyFeatureReachable } from "./reachability";
import { judgeFeature } from "../greenfield/judge";
import { autofixApps, readResourceCode, rescueFileFor } from "./build";

/**
 * The command stage: apply BoringStack's deterministic auto-fixes, sync the DB to
 * whatever columns the model just added, then run the composed `validate && check`
 * gate. Auto-fix + db:push run EVERY cycle here (what a dev gets on save) so those
 * never cost the model a gate attempt. On failure each parsed failure SIGNATURE
 * becomes an `IErrorItem` whose `key` IS the signature — so the differential
 * wrapper can suppress baseline signatures and `checkStuck` can fingerprint them.
 */
export function boringstackCommandStage(cwd: string, exec: Exec): IStage {
  return {
    async run(): Promise<IValidateResult> {
      await autofixApps(cwd, exec);
      await exec(["bun", "run", "db:push", "--", "--force"], {
        cwd: join(cwd, "apps/api"),
      });

      const result = await runBoringstackGate(cwd, exec);

      if (result.passed) {
        return { passed: true, errors: [], output: result.output };
      }

      const signatures = [...extractFailures(result.output, cwd)];
      const errors =
        signatures.length > 0
          ? signatures.map((sig) => ({ key: sig, message: sig }))
          : [{ key: "gate-nonzero", message: result.output.slice(0, 500) }];

      return { passed: false, errors, output: result.output };
    },
  };
}

/**
 * A feature isn't "done" just because it COMPILES — it must be reachable and
 * usable. This stage runs the static reachability check (route wired, API mounted,
 * i18n keys present); a failure becomes one gate error the loop can escalate on.
 */
export function reachabilityStage(cwd: string, featureId: string): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const reach = await verifyFeatureReachable(cwd, featureId);

      if (reach.ok) {
        return { passed: true, errors: [], output: "reachable" };
      }

      const message =
        `"${featureId}" is not reachable/usable:\n- ` +
        reach.problems.join("\n- ");

      return {
        passed: false,
        errors: [
          { key: `reachability:${featureId}`, rule: "reachability", message },
        ],
        output: message,
      };
    },
  };
}

/**
 * The reject-by-default quality judge as a gate stage. Its prose rejection becomes
 * ONE gate error: `rule: "judge"`, `file` = the resource's service file (via
 * `rescueFileFor`) so the fingerprint is stable across repeated judge rejections on
 * the same feature and the expert (R4) can resolve a file to hand off.
 */
export function judgeStage(
  evaluator: IProvider,
  cwd: string,
  feature: IFeature
): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const code = await readResourceCode(cwd, feature.id);
      const verdict = await judgeFeature(evaluator, { feature: feature.desc, code });

      if (verdict.ok) {
        return { passed: true, errors: [], output: "judge: pass" };
      }

      const file = await rescueFileFor(cwd, feature);
      const message = `judge rejected "${feature.id}": ${verdict.notes}`;

      return {
        passed: false,
        errors: [
          {
            key: `judge:${feature.id}`,
            rule: "judge",
            ...(file === null ? {} : { file }),
            message,
          },
        ],
        output: message,
      };
    },
  };
}

/**
 * Compose the full BoringStack gate: differential command (suppress baseline) →
 * reachability → judge. Short-circuited, so the model call (judge) fires only when
 * the code compiles/lints clean AND the feature is reachable. Baseline lives in the
 * differential wrapper's closure — captured once at build start.
 */
export function composeBoringstackGate(opts: {
  cwd: string;
  exec: Exec;
  evaluator: IProvider;
  baseline: ReadonlySet<string>;
  feature: IFeature;
}): IGate {
  const { cwd, exec, evaluator, baseline, feature } = opts;

  return composeGate([
    differentialStage(boringstackCommandStage(cwd, exec), baseline),
    reachabilityStage(cwd, feature.id),
    judgeStage(evaluator, cwd, feature),
  ]);
}
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `cd packages/core && bun test tests/boringstack-gate-stages.test.ts && bunx tsc --noEmit 2>&1 | tail -15`
Expected: tests PASS; no type errors. If `rescueFileFor`/`readResourceCode` aren't exported from `build.ts`, export them (they're already `export`ed per the source — verify).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/loop/boringstack/gate-stages.ts packages/core/tests/boringstack-gate-stages.test.ts packages/core/src/loop/boringstack/build.ts
git commit -m "feat(boringstack): gate stages (command/differential/reachability/judge) + composeBoringstackGate"
```

---

## Phase 4 — Dissolve the implement/evaluate split

### Task 5: Simplify `IGreenfieldDeps` + `runGreenfield` — delete the band-aids

**Files:**
- Modify: `packages/core/src/loop/greenfield/greenfield.types.ts`
- Modify: `packages/core/src/loop/greenfield/run.ts`
- Delete: `packages/core/src/loop/greenfield/evaluate.ts`
- Modify: `packages/core/tests/greenfield.test.ts`

**Interfaces:**
- Consumes: `IHandoff`, `EscalationRung` from `../loop.types`.
- Produces (new `IGreenfieldDeps`):
  ```typescript
  export interface IGreenfieldDeps {
    implement(
      feature: IFeature,
      state: IGreenfieldState,
      seed?: { triedLevers: EscalationRung[] }
    ): Promise<{ done: boolean; handoff?: IHandoff }>;
  }
  ```

- [ ] **Step 1: Rewrite `attemptFeature` tests first**

In `packages/core/tests/greenfield.test.ts`, replace tests that assert `escalateGuidance`/`evaluate`/`rescue` behavior with tests of the new contract. Delete the `escalateGuidance` import and its tests. Add:

```typescript
test("attemptFeature: implement returns done → feature ticks passing", async () => {
  const state = { goal: "g", features: [{ id: "a", desc: "A", passes: false, attempts: 0 }] };
  const deps = { implement: async () => ({ done: true }) };
  const result = await runGreenfield(tmpCwd, state, deps as never, {});

  expect(result.status).toBe("done");
  expect(state.features[0]?.passes).toBe(true);
});

test("attemptFeature: implement returns handoff → feature parks, then revisit", async () => {
  const state = { goal: "g", features: [{ id: "a", desc: "A", passes: false, attempts: 0 }] };
  let calls = 0;
  const handoff = {
    block: "a", rungHistory: [], errors: ["stuck"], ask: "help",
    resumable: true as const, resume: { triedLevers: [] },
  };
  const deps = {
    implement: async () => {
      calls += 1;

      return calls === 1 ? { done: false, handoff } : { done: true };
    },
  };
  const result = await runGreenfield(tmpCwd, state, deps as never, {});

  expect(calls).toBe(2); // main pass parks, revisit pass retries seeded
  expect(result.status).toBe("done");
});
```

(Use the existing test's `tmpCwd`/temp-dir helper. `as never` is confined to the deps test double.)

- [ ] **Step 2: Run to verify the new tests fail (and old ones are gone)**

Run: `cd packages/core && bun test tests/greenfield.test.ts 2>&1 | tail -20`
Expected: FAIL — `implement` still returns `{ handoff? }` without `done`; `escalateGuidance` import removed so any leftover reference errors.

- [ ] **Step 3: Update `greenfield.types.ts`**

Replace `IGreenfieldDeps` (lines 63–88) with the new interface above. Delete the `IFeatureVerdict` interface (lines 44–54) — nothing consumes it after `evaluate` is gone (confirm with `grep -rn IFeatureVerdict src`). Import `EscalationRung` from `../loop.types`.

- [ ] **Step 4: Rewrite `attemptFeature` and delete the band-aids in `run.ts`**

In `packages/core/src/loop/greenfield/run.ts`:
- Delete `escalateGuidance` (lines 160–179) and its export.
- Delete `EVAL_STALL_BACKSTOP` (line 158).
- Replace `attemptFeature` (lines 181–284) with:

```typescript
async function attemptFeature(
  cwd: string,
  state: IGreenfieldState,
  feature: IFeature,
  deps: IGreenfieldDeps,
  say: (message: string) => void,
  seed?: { triedLevers: EscalationRung[] }
): Promise<void> {
  feature.attempts += 1;
  const seedNote = seed ? " (revisit, seeded with tried-levers)" : "";

  say(
    `feature '${feature.id}': attempt ${feature.attempts} — ${feature.desc}${seedNote}`
  );

  // Persist in `finally` so a THROW still records the bumped attempt count before
  // it propagates (resume-from-crash correctness).
  try {
    const result = await deps.implement(feature, state, seed);

    if (result.done) {
      feature.passes = true;
      delete feature.lastError;
      delete feature.parked;
      delete feature.handoff;
      say(`feature '${feature.id}': verified ✓`);

      return;
    }

    // Not done → the shared ladder (R1–R4 + R5) already ran inside the loop and
    // exhausted. Park on its structured handoff for the revisit pass.
    feature.parked = true;

    if (result.handoff !== undefined) {
      feature.handoff = result.handoff;
    }

    say(`feature '${feature.id}': ladder exhausted, parked — revisit later`);
  } finally {
    await saveState(cwd, state);
    await writeProgress(cwd, state);
  }
}
```

- Update the seed type in `runGreenfield`'s revisit pass (line 94–98) so `seed` is `{ triedLevers: EscalationRung[] }` (matching `IHandoff.resume`). Remove the `"triedLevers" in feature.handoff.resume` narrowing only if the resume type is always the `triedLevers` variant; otherwise keep the guard but type it to `EscalationRung[]`.

- [ ] **Step 5: Delete `evaluate.ts`**

```bash
git rm packages/core/src/loop/greenfield/evaluate.ts
```
Then fix imports: `grep -rn "greenfield/evaluate" packages/core/src` and remove/redirect each (boringstack `build.ts` imported `evaluateFeature`/`IEvaluateDeps`/`IGateOutcome`/`IJudgeOutcome` — those go away in Task 6; if Task 6 isn't done yet, temporarily leave `build.ts` broken and note it — but prefer doing Task 6 immediately after so the tree compiles).

- [ ] **Step 6: Run the greenfield tests**

Run: `cd packages/core && bun test tests/greenfield.test.ts 2>&1 | tail -20`
Expected: the new tests PASS. (`build.ts` may not compile yet — that's Task 6. If the test file imports transitively pull `build.ts`, do Task 6 before running the full suite.)

- [ ] **Step 7: Commit (with Task 6, if the tree needs it to compile)**

```bash
git add -A packages/core/src/loop/greenfield packages/core/tests/greenfield.test.ts
git commit -m "refactor(greenfield): implement→{done,handoff}; delete evaluate.ts, escalateGuidance, EVAL_STALL_BACKSTOP (ladder now fires in-loop)"
```

### Task 6: Rewire `boringstackDeps` + `runBoringstackBuild` to inject the live gate

**Files:**
- Modify: `packages/core/src/loop/boringstack/build.ts`

**Interfaces:**
- Consumes: `composeBoringstackGate` from `./gate-stages` (Task 4); `IGreenfieldDeps` (new shape, Task 5); `IBoringstackHost` gains `setGate(gate: IGate): void`.
- Produces: `boringstackDeps` returns the new `IGreenfieldDeps` (implement only).

- [ ] **Step 1: Extend `IBoringstackHost` with `setGate`**

In `build.ts`, change the interface (lines 185–190):

```typescript
interface IBoringstackHost {
  setScope(globs: string[]): void;
  setGate(gate: import("../../gate/gate-runner").IGate): void;
  send(
    message: string
  ): Promise<{ status: string; turns: number; handoff?: IHandoff }>;
}
```

- [ ] **Step 2: Rewrite `boringstackDeps` to implement-only, with the live gate**

Replace the returned object (lines 226–409) with:

```typescript
  return {
    async implement(
      feature: IFeature,
      _state: IGreenfieldState
    ): Promise<{ done: boolean; handoff?: IHandoff }> {
      // Pre-step: generate the full vertical slice + sync the STUB schema. The
      // model then fills the domain INSIDE the loop, checked by the live gate.
      await generate(cwd, feature.id, exec);
      await genUi(cwd, feature.id, exec);
      host.setScope(scopeFor(feature.id));
      await exec(["bun", "run", "db:push", "--", "--force"], {
        cwd: join(cwd, "apps/api"),
      });

      // Inject THIS feature's composed gate (differential command + reachability +
      // judge). Now settleGate runs it every cycle and the shared ladder escalates
      // on lint/judge/reachability failures — the whole point of the unification.
      host.setGate(
        composeBoringstackGate({ cwd, exec, evaluator, baseline, feature })
      );

      const slice = sliceFor?.(feature.id);
      const sent = await host.send(refinePrompt(feature, slice));

      return {
        done: sent.status === "done",
        ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
      };
    },
  };
```

- [ ] **Step 3: Remove now-dead imports + helpers**

Delete the imports of `evaluateFeature`, `IEvaluateDeps`, `IGateOutcome`, `IJudgeOutcome` (evaluate.ts is gone), `judgeFeature`, `runBoringstackGate` (now used only inside `gate-stages.ts`), `extractFailures`/`novelFailures` (used inside stages), `verifyFeatureReachable`, `resolveExpertAsk`/`resolveStuckFile`/`runExpertHandoff` (the bespoke rescue is gone). Keep: `generateResource`/`generateFeature`, `refinePrompt`, `runGreenfield`, `slicesToFeatures`, `loadApprovedPlan`, plan types, `scopeFor`, `toCamelCase`. Keep `runBoringstackGate` + `extractFailures` imports in `build.ts` ONLY where `runBoringstackBuild` captures the baseline (Step 4). Add `import { composeBoringstackGate } from "./gate-stages";`. Keep `autofixApps`, `readResourceCode`, `rescueFileFor` exported (Task 4 uses them).

- [ ] **Step 4: `runBoringstackBuild` — unchanged baseline capture, still drives `runGreenfield`**

`runBoringstackBuild` keeps its baseline capture (lines 449–463: `runBoringstackGate` + `extractFailures`) and still calls `runGreenfield(cwd, state, boringstackDeps({...baseline...}), opts)`. No structural change — `runGreenfield`'s new `attemptFeature` (Task 5) consumes the new `implement`. Confirm `boringstackDeps` is still passed `baseline`.

- [ ] **Step 5: Typecheck the whole package**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | tail -25`
Expected: clean. Fix any dangling reference to the removed `evaluate`/`rescue`/`IFeatureVerdict`.

- [ ] **Step 6: Run the boringstack + greenfield tests**

Run: `cd packages/core && bun test tests/greenfield.test.ts tests/boringstack*.test.ts 2>&1 | tail -20`
Expected: PASS. Update any boringstack test that asserted the old `evaluate`/`rescue` deps shape to the new implement-only shape.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/loop/boringstack/build.ts
git commit -m "refactor(boringstack): implement = pre-step + send with live composed gate; delete evaluate/rescue (ladder is R4/R5)"
```

### Task 7: `headless-build.ts` — Session supports the per-feature gate

**Files:**
- Modify: `packages/core/scripts/headless-build.ts`

**Interfaces:**
- Consumes: `Session` with `setGate` (Task 3); `runBoringstackBuild` (Task 6).

- [ ] **Step 1: Confirm the host is the Session and satisfies the new interface**

Run: `cd packages/core && grep -n "Session.create\|setScope\|runBoringstackBuild\|host" scripts/headless-build.ts`
The Session instance is passed as `host` to `runBoringstackBuild` (structurally satisfying `IBoringstackHost`). Since `Session` now has `setGate` (Task 3) and `setScope`, no signature change is needed. If `headless-build` builds a bespoke host object instead of passing the `Session`, add a `setGate(gate) { session.setGate(gate); }` delegate to it.

- [ ] **Step 2: Ensure the Session is created able to bear a gate**

The Session may be created without `accept` (fine now — `implement` calls `host.setGate` per feature before `host.send`, which flips `hasGate` on). No `accept` needs to be added. Verify the `Session.create({...})` call still compiles and passes `provider`, `cwd`, `files`, `contextWindow`, `guidance`, `report`.

- [ ] **Step 3: Typecheck**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | tail -15`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/headless-build.ts
git commit -m "chore(headless-build): host bears per-feature gate via Session.setGate"
```

### Task 8: `cli.ts` greenfield path — inject a composed gate, drop the crutches

**Files:**
- Modify: `packages/core/src/cli.ts`

**Interfaces:**
- Consumes: `composeGate`, `commandGate` from `gate/gate-runner`; the new `IGreenfieldDeps` (implement-only).

- [ ] **Step 1: Rewrite `greenfieldDeps`**

In `packages/core/src/cli.ts`, `greenfieldDeps` (lines ~570–609) currently returns `implement` (calling `runTask` with `requireRed:false`) + `evaluate` + `rescue`. Replace with implement-only that passes a composed gate and drops `requireRed:false`:

```typescript
function greenfieldDeps(
  args: ICliArgs,
  work: OpenAICompatibleProvider,
  evaluator: OpenAICompatibleProvider,
  scope: string[],
  report: Reporter
): IGreenfieldDeps {
  return {
    implement: async (feature) => {
      const base = {
        id: feature.id,
        intent: feature.desc,
        accept: args.accept,
        files: scope,
        context: [],
      };
      // The composed gate (Step 2): the --accept command + the reject-by-default
      // judge. (Generic CLI greenfield has no browser/reachability target.) The
      // judge makes the gate RED until the feature is really built, so RED-first
      // holds and we no longer need requireRed:false.
      const gate = composeGate([
        { run: (cwd, opts) => validate(base, cwd, undefined, opts ?? {}) },
        judgeStage(evaluator, args.dir, feature),
      ]);
      const result = await runTask(base, args.dir, work, {
        onEvent: report,
        gate,
      });

      return {
        done: result.status === RUN_STATUS.done,
        ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
      };
    },
  };
}
```

- [ ] **Step 2: Add the imports the gate needs**

At the top of `packages/core/src/cli.ts` add (or confirm present):

```typescript
import { composeGate } from "../gate/gate-runner";
import { judgeStage } from "./loop/boringstack/gate-stages";
import { validate } from "../validate";
```

`judgeStage` is mode-agnostic — it needs only `evaluator`, `cwd`, and `feature`. If importing a `boringstack/` symbol into the generic CLI path reads wrong to the reviewer, the clean follow-up is to relocate `judgeStage` into `gate/gate-runner.ts` as a generic stage; do NOT block this task on that — note it as a Minor for the final review. Drop the old `evaluate`/`rescue`/`requireRed:false` code entirely.

- [ ] **Step 3: Typecheck + the CLI/greenfield tests**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | tail -15 && bun test tests/greenfield.test.ts 2>&1 | tail -10`
Expected: clean; tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cli.ts
git commit -m "refactor(cli): greenfield injects composed gate (command+judge) into runTask; drop requireRed/evaluate/rescue"
```

---

## Phase 5 — Prove it, and update the docs

### Task 9: Proof test — a judge/lint stall escalates through the shared ladder

**Files:**
- Test: `packages/core/tests/unified-escalation.test.ts` (create)

This is the correctness proof for the whole plan: a feature whose gate stays RED on a **judge** failure (the exact class that ground live with zero escalations) must now climb the shared ladder and hand off.

**Interfaces:**
- Consumes: `runTask` (`loop/run.ts`); a `ScriptedModel`/fake `IProvider` (reuse the harness in `packages/core/tests/` used by existing loop tests — grep `ScriptedModel` or the fake provider pattern); `composeGate` + an always-red `IStage`.

- [ ] **Step 1: Write the test**

```typescript
import { test, expect } from "bun:test";
import { runTask } from "../src/loop/run";
import { composeGate, type IStage } from "../src/gate/gate-runner";
import { RUN_STATUS, STUCK_REASON } from "../src/loop";

test("a persistently-red judge gate escalates through the ladder and hands off (no infinite identical grind)", async () => {
  // A gate that ALWAYS rejects on the same judge error — the live failure class.
  const alwaysRed: IStage = {
    run: async () => ({
      passed: false,
      errors: [{ key: "judge:note", rule: "judge", file: "note.ts", message: "still a stub" }],
      output: "still a stub",
    }),
  };
  // A model that makes an edit each turn but never satisfies the judge.
  const model = makeScriptedModel(/* emits a benign edit then yields, each turn */);

  const result = await runTask(
    { id: "note", intent: "build note", accept: "true", files: ["**/*"], context: [] },
    tmpCwd,
    model,
    { gate: composeGate([alwaysRed]), maxTurns: 60 }
  );

  // The primary terminal is ladder-exhaustion (R5 handoff), NOT the turn cap.
  expect(result.status).toBe(RUN_STATUS.stuck);
  expect(result.reason).toBe(STUCK_REASON.handoff);
  expect(result.handoff).toBeDefined();
  // The block was tracked and levers were tried (escalation actually fired).
  expect(result.handoff?.rungHistory.length ?? 0).toBeGreaterThan(0);
});
```

Wire `makeScriptedModel` to the existing fake-provider utility (see how `tests/expert-rescue.test.ts` / loop tests build a provider). The model must produce enough turns for `checkStuck` to detect the stall on the sticky `judge:note` block.

- [ ] **Step 2: Run it**

Run: `cd packages/core && bun test tests/unified-escalation.test.ts 2>&1 | tail -15`
Expected: PASS — proves the ladder now escalates on a judge failure fed through the injected gate. If it hangs or returns `cap` instead of `handoff`, the sticky-block/`checkStuck` wiring isn't seeing the injected gate's errors — debug `runGateStep` → `checkStuck` before declaring done.

- [ ] **Step 3: Full validate**

Run: `cd packages/core && bun run validate 2>&1 | tail -25`
Expected: read the real `N pass / M fail` line — all green, no lint/type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/unified-escalation.test.ts
git commit -m "test(loop): prove judge/lint stall escalates through the shared ladder → handoff"
```

### Task 10: Update the Astro docs to the unified model

**Files:**
- Modify: `docs/harness-subsystems.md` (or the Astro `.mdx` equivalent — grep first)
- Modify: `docs/superpowers/plans/2026-07-12-boringstack-build-loop.md` (mark superseded)
- Modify: `docs/superpowers/specs/2026-07-12-boringstack-fullstack-build-pivot-design.md` (mark superseded)
- Modify: any Astro docs page describing "implement→evaluate" or "greenfield vs boringstack modes" or the loop/gate

- [ ] **Step 1: Find every stale reference**

Run: `cd /Users/ag/Documents/Code/tsforge && grep -rn "implement→evaluate\|implement/evaluate\|escalateGuidance\|EVAL_STALL_BACKSTOP\|gateless\|two-step\|evaluate step" docs`
List each hit.

- [ ] **Step 2: Correct the loop/gate description**

In the harness-subsystems / validation docs, replace any "implement→evaluate→persist cycle" and "gate runs outside the loop" text with: one loop; the gate is an injected composed `IGate` (command → differential → reachability → judge stages) that runs INSIDE the loop each cycle; both `runTask` and `Session` share `settleGate`/`checkStuck`; the escalation ladder therefore fires for every mode. Note the planner concept (goal → feature checklist) unchanged.

- [ ] **Step 3: Mark the superseded specs/plans**

At the top of `docs/superpowers/specs/2026-07-12-boringstack-fullstack-build-pivot-design.md` and `docs/superpowers/plans/2026-07-12-boringstack-build-loop.md`, add:

```markdown
> **SUPERSEDED (2026-07-14)** by the unified build loop —
> `docs/superpowers/specs/2026-07-14-unified-build-loop-design.md`. The
> implement/evaluate split described below is removed; the real gate now runs
> inside the loop as a composed `IGate`.
```

- [ ] **Step 4: Build the docs site to confirm no broken references**

Run the docs build the repo uses (grep `package.json` for an `astro build` / `docs` script; e.g. `cd docs && bun run build` or the root `bun run docs:build`).
Expected: builds clean, no dead-link/reference errors.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: update harness docs to the unified in-loop composed-gate model; mark two-step boringstack docs superseded"
```

---

## Verification (whole-branch, after all tasks)

- [ ] `cd packages/core && bun run validate` — read the real `N pass / M fail` tail: fully green, no `as`/disable/type errors, CC ≤ 20.
- [ ] Grep-proof of unification: `grep -rn "settleGate\|checkStuck" packages/core/src | grep -v turn.ts` returns only CALL sites (both drivers), never a second implementation. `grep -rn "escalateGuidance\|EVAL_STALL_BACKSTOP\|IGreenfieldDeps\).*evaluate" packages/core/src` returns nothing.
- [ ] **Live proof (manual):** re-run the notes-app BoringStack build against the unified loop:
  ```
  TSFORGE_EXPERT_RESCUE=1 bun run packages/core/scripts/headless-build.ts <notesapp-clone> "…" --log <logfile>
  ```
  Watch the log: on a lint/judge stall it must show the ladder climbing (R1 diagnose → R2 perturb → R3 narrow → R4 expert → R5 handoff), NOT the same gate error repeating with zero escalations. Success = recovery-to-green, or a bounded handoff after climbing the ladder — never an identical grind.

## Not doing / deferred
- Merging `runTask` and `Session` into one driver (unnecessary; risky; loses Session's long-run features).
- A new `IBuildUnit`/`IPlanner` type migration — the existing `IFeature[]` checklist already is the unit list.
- New gate stages beyond those that exist today (browser stage is greenfield-CLI-only and already skip-tolerant).
- Per-project port isolation for concurrent boringstack builds (separate concern; captured in the boringstack-fullstack memory).
