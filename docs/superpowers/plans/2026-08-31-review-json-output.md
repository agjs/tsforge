# `tsforge review --json` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--json` flag to `tsforge review` that emits the review's
`IReviewReport` as a single line of JSON instead of the formatted-text
report, with the same non-zero-on-error-finding exit code — giving
downstream tooling (a GitHub-integration adapter, in particular) a stable,
parseable contract instead of scraped text.

**Architecture:** A new pure function, `renderReport(report, json)`, lives
next to the existing `formatReport` in `packages/core/src/loop/review/
review-change.ts` and picks between `JSON.stringify(report)` and
`formatReport(report)`. `--json` is parsed the same way every other boolean
review flag (`--staged`, `--with-gate`) is parsed in `packages/core/src/
cli/args.ts`. `reviewMode` in `packages/core/src/cli.ts` calls
`renderReport` instead of calling `formatReport` directly. No change to
`review()`'s behavior, model calls, or exit-code logic.

**Tech Stack:** Bun, TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-31-tsforge-agentic-pr-reviewer-design.md`
in the sibling `argocd-app-of-apps` repo (Component 1) — this plan
implements the upstream prerequisite that repo's Component 2 (the
GitHub-integration adapter) consumes.

## Global Constraints

- No `as` type assertions — narrow with guards (`AGENTS.md`).
- No `eslint-disable` — fix the root cause (`AGENTS.md`).
- Cyclomatic complexity ≤ 20 (`AGENTS.md`).
- Interfaces prefixed `I`; types live in `*.types.ts` (`AGENTS.md`) — not
  applicable here (no new interface/type is introduced), but any touched
  file must not be made to violate this.
- Every new logic file needs a behavioral test sibling; every touched
  logic file needs its existing/new behavior covered by a test that has
  actually been watched to fail first (`AGENTS.md`).
- Run `bun run ci:local` (mirrors CI: rules + arch drift + validate) before
  the final push, from the repo root
  (`/Users/ag/Documents/Code/boringstack-xyz/tsforge`).
- The exit-code contract (`report.findings.some(f => f.severity ===
  "error") ? 1 : 0`) in `reviewMode` must not change.

---

## Task 1: `renderReport` — the pure output-format function

**Files:**
- Modify: `packages/core/src/loop/review/review-change.ts` (add
  `renderReport`, after the existing `formatReport` function — currently
  ends around line 175)
- Test: `packages/core/tests/review-change.test.ts` (new file — no test
  file exists yet for `review-change.ts`)

**Interfaces:**
- Consumes: `IReviewReport` from `./review.types` (already imported in
  `review-change.ts`); `formatReport` (already defined in the same file).
- Produces: `export function renderReport(report: IReviewReport, json:
  boolean): string` — used by Task 2's `reviewMode` change.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/review-change.test.ts`:

```ts
import { test, expect } from "bun:test";
import { renderReport, formatReport } from "../src/loop/review/review-change";
import type { IReviewReport } from "../src/loop/review/review.types";

const BASE_REPORT: IReviewReport = {
  base: "main",
  changedFiles: ["src/a.ts"],
  findings: [
    {
      file: "src/a.ts",
      line: 10,
      severity: "error",
      lens: "logic",
      claim: "off-by-one",
      reason: "loop reads one past the array end",
      verified: true,
      verdict: "confirmed",
    },
  ],
  rejected: 0,
};

test("renderReport(json=true) emits the report as a single JSON line, not the text format", () => {
  const out = renderReport(BASE_REPORT, true);

  expect(out).not.toContain("\n");
  expect(JSON.parse(out)).toEqual(BASE_REPORT);
});

test("renderReport(json=false) falls through to formatReport, unchanged", () => {
  expect(renderReport(BASE_REPORT, false)).toBe(formatReport(BASE_REPORT));
});

test("renderReport(json=true) round-trips an empty-findings report too", () => {
  const empty: IReviewReport = { ...BASE_REPORT, findings: [] };
  const out = renderReport(empty, true);

  expect(JSON.parse(out)).toEqual(empty);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/tests/review-change.test.ts`
Expected: FAIL — `renderReport` is not exported from
`../src/loop/review/review-change` (a `TypeError` or "is not a function"
/ "is not exported" error, depending on Bun's exact message).

- [ ] **Step 3: Implement `renderReport`**

In `packages/core/src/loop/review/review-change.ts`, immediately after the
closing brace of the existing `formatReport` function, add:

```ts
/** Render a report as either a single line of JSON (a stable, parseable
 *  contract for downstream tooling — e.g. a CI integration that turns
 *  findings into inline PR comments) or the existing plain-text format.
 *  JSON output is exactly `JSON.stringify(report)`: no re-shaping, so the
 *  contract is the same `IReviewReport` type callers of `review()` already
 *  see, not a second, drifting shape. */
export function renderReport(report: IReviewReport, json: boolean): string {
  return json ? JSON.stringify(report) : formatReport(report);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/tests/review-change.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/review/review-change.ts packages/core/tests/review-change.test.ts
git commit -m "feat(review): add renderReport for JSON vs text output"
```

---

## Task 2: `--json` CLI flag

**Files:**
- Modify: `packages/core/src/cli/args.ts`
  - `ICliArgs` interface (add a `json` field near `staged`/`withGate`,
    currently lines 41-47)
  - `BOOL_FLAGS` type union (currently lines 104-119)
  - `BOOL_FLAGS` object (currently lines 120-138)
  - `parseArgs`'s default `out` object literal (currently lines 238-278)
  - `cliUsage()`'s review usage line (currently line 209)
- Modify: `packages/core/src/cli.ts` — `reviewMode` (currently lines
  201-244): replace the `formatReport(report)` call with `renderReport(
  report, args.json)`, and add the `renderReport` import.
- Test: `packages/core/tests/cli.test.ts` (existing file — add new tests
  near the other `parseArgs`/`cliUsage` tests, e.g. after the
  `"cliUsage documents the print-and-exit flags it is reached by"` test
  at line 525)

**Interfaces:**
- Consumes: `renderReport` from Task 1 (`packages/core/src/loop/review/
  review-change.ts`).
- Produces: `ICliArgs.json: boolean` — every future caller of `parseArgs`
  sees this field; `reviewMode` reads it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/tests/cli.test.ts` (after the existing `cliUsage`
test around line 537):

```ts
test("--json sets args.json for review", () => {
  expect(parseArgs(["review", "--json"]).json).toBe(true);
  expect(parseArgs(["review"]).json).toBe(false);
});

test("--json composes with --staged and --base without interfering", () => {
  const a = parseArgs(["review", "--staged", "--json", "--base", "origin/main"]);

  expect(a.json).toBe(true);
  expect(a.staged).toBe(true);
  expect(a.base).toBe("origin/main");
});

test("cliUsage documents --json for review", () => {
  expect(cliUsage()).toContain("--json");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/tests/cli.test.ts`
Expected: FAIL — `parseArgs(...).json` is `undefined`, not `true`/`false`
(the `--json` token isn't a known flag yet, so it's swallowed into
`args.task` instead — the `--staged`/`--base` composition test will also
show `a.json` as `undefined`, and `cliUsage()` won't contain `"--json"`).

- [ ] **Step 3: Implement the flag**

In `packages/core/src/cli/args.ts`:

3a. Add the field to `ICliArgs` (after the `withGate` doc/field at line
47, before `withReview`):

```ts
  /** Emit the review report as a single line of JSON instead of formatted
   *  text (`tsforge review --json`) — a stable contract for scripting. */
  json: boolean;
```

3b. Add `"json"` to the `BOOL_FLAGS` type union (in the list at lines
104-119, alongside `"staged" | "withGate"`):

```ts
  | "json"
```

3c. Add the flag mapping to the `BOOL_FLAGS` object (alongside
`"--with-gate": "withGate",` at line 129):

```ts
  "--json": "json",
```

3d. Add the default value to `parseArgs`'s `out` object literal (alongside
`staged: false,` at line 254):

```ts
    json: false,
```

3e. Update the review usage line in `cliUsage()` (line 209):

```ts
    "  tsforge review [--staged] [--json]  functional review of the current diff",
```

`formatReport` reaches `cli.ts` through two re-export barrels:
`review-change.ts` → `packages/core/src/loop/review/index.ts` →
`packages/core/src/loop/index.ts` → `cli.ts`'s top import. `renderReport`
needs adding to both barrels, then to `cli.ts`'s import.

3f. In `packages/core/src/loop/review/index.ts`, add `renderReport` to the
existing `review-change` re-export (currently lines 1-6):

```ts
export {
  formatReport,
  renderReport,
  detectBase,
  collectChangedFiles,
  dedupeFindings,
} from "./review-change";
```

3g. In `packages/core/src/loop/index.ts`, add `renderReport` to the
existing re-export block (currently lines 89-96 — the one containing
`review, reviewAgents, formatReport, formatReviewCard, LENSES, ...`):

```ts
export {
  review,
  reviewAgents,
  formatReport,
  renderReport,
  formatReviewCard,
  LENSES,
  type IReviewAgentsOptions,
  type IReviewReport,
```

(Leave the rest of that export block — everything after `type
IReviewReport,` — exactly as it already is; this only inserts one new
line.)

3h. In `packages/core/src/cli.ts`, add `renderReport` to the top import
block (currently lines 2-13, which already imports `formatReport` on line
7):

```ts
import {
  runTask,
  RUN_STATUS,
  review,
  reviewRepair,
  formatReport,
  renderReport,
  runGreenfield,
  prepareState,
  planFeatures,
  type IGreenfieldDeps,
  type Reporter,
} from "./loop";
```

3i. Replace the report-printing line inside `reviewMode` (currently line
240):

```ts
  process.stdout.write(`\n${formatReport(report)}\n`);
```

with:

```ts
  process.stdout.write(
    args.json ? `${renderReport(report, true)}\n` : `\n${renderReport(report, false)}\n`
  );
```

(`formatReport` stops being called directly in `cli.ts` after this change
— it's still used, just through `renderReport`. If the linter flags the
now-unused `formatReport` import from Step 3h's block, remove it from that
import list; `renderReport` alone is sufficient.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/tests/cli.test.ts packages/core/tests/review-change.test.ts`
Expected: PASS (all tests, including Task 1's).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/args.ts packages/core/src/cli.ts packages/core/tests/cli.test.ts
git commit -m "feat(cli): add --json to tsforge review"
```

---

## Task 3: Full validation + release

**Files:** none (verification only).

**Interfaces:** none — this task only runs the project's own gates.

- [ ] **Step 1: Run the full local CI mirror**

Run (from the repo root, `/Users/ag/Documents/Code/boringstack-xyz/tsforge`):
`bun run ci:local`
Expected: PASS — this covers `rules:check`, `arch:check`, and
`validate` (typecheck/lint/format/test/e2e). If `arch:check` fails because
`ARCHITECTURE.md` drifted (it may, since `review-change.ts` gained an
export), run `bun run arch:build` to regenerate it, review the diff, and
commit it as part of this task.

- [ ] **Step 2: Manually verify the end-to-end CLI behavior**

From a real git repo with an uncommitted change (or against this
tsforge checkout itself, using the change from Tasks 1-2):

```bash
bun run tsforge review --staged --json | tail -1 | jq .
```

Expected: valid JSON on stdout, parseable by `jq`, with `base`,
`changedFiles`, `findings`, `rejected` keys matching `IReviewReport`.
Compare against `bun run tsforge review --staged` (no `--json`) to confirm
the text-format path still renders normally.

- [ ] **Step 3: Commit any `ARCHITECTURE.md` regeneration from Step 1**

```bash
git add packages/core/ARCHITECTURE.md
git commit -m "docs: regenerate ARCHITECTURE.md after review-change.ts change"
```

(Skip this step entirely if Step 1 reported no drift.)

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat: add --json to tsforge review" --body "Adds a --json flag to \`tsforge review\` that emits the report's IReviewReport as a single line of JSON instead of formatted text, for scripting/CI integration (e.g. turning findings into GitHub PR review comments). Exit-code behavior (non-zero on error-severity findings) is unchanged."
```

(Branch name and exact PR body wording are the implementer's call at
execution time — this step's substance is "push and open a PR describing
the change," not a specific string.)

## Self-review notes

- **Spec coverage:** Component 1 of the design spec asks for exactly one
  thing — a `--json` flag on `tsforge review` emitting the structured
  report, exit code unchanged. Task 1 (pure render function) + Task 2 (flag
  wiring) + Task 3 (validation) cover it completely.
- **Placeholder scan:** every step has real file paths, real code, real
  commands — no "TBD"/"add appropriate handling" left in.
- **Type consistency:** `renderReport(report: IReviewReport, json:
  boolean): string` is defined once in Task 1 and consumed with the same
  signature in Task 2 — no drift between tasks.
