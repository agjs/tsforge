# harness_reviewers — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent external review gate — a panel of other models/binaries that judges a harness change and produces a deterministic blocking verdict the builder cannot fake — exposed as `tsforge harness-review`, enforced in CI.

**Architecture:** A thin `packages/core/src/reviewers/*` core: a frozen `IReviewRequest`/`IReview`/`IVerdict` schema, a `reviewPanel` config block (sibling to `capabilities`), a pure `registry` (resolve + independence + floor minReviewers), a fault-tolerant parallel `invoke` (model reviewers via the existing `OpenAICompatibleProvider`, binaries via subprocess), a **pure deterministic** `aggregate`, and a `harness-review` orchestrator (gather diff+intent+validate → budget → invoke → aggregate → artifact → exit code). CI runs it as the authority; a git pre-push hook is convenience.

**Tech Stack:** TypeScript (strict), Bun (`bun:test`, `Bun.spawn`), the existing `models-config` + `inference` (`OpenAICompatibleProvider`, `extractJson`) seams. No new dependencies.

## Global Constraints
- No `as` (except `as const`), no non-null `!`, no `eslint-disable`/`@ts-ignore`. Cognitive complexity ≤ 20 (extract helpers). Never relax the gate.
- Branch `feat/escalation-ladder`. Commit unsigned: `git -c commit.gpgsign=false commit -m "…"`.
- Absolute clickable paths in reports. `bun run validate` must be green before every commit.
- **Independence invariant:** a reviewer whose normalized `(baseUrl host, model id)` equals the active builder model's — or whose model entry name equals the active entry name — is rejected. `minReviewers` is floored at 2 in code for `harness-review`.
- **Errored ≠ approved:** a reviewer that fails/times-out/parse-fails is recorded `errored`, never counted as an approval.
- **No silent truncation:** an over-budget diff BLOCKS with a reason; it is never quietly cut.
- Reviewer schema, request, and verdict types are **frozen** — Phase 2 reuses them unchanged.

---

## File Structure

- `packages/core/src/reviewers/schema.ts` — frozen types (`IFinding`, `IReview`, `IReviewRequest`, `IVerdict`), `FindingCode` enum, `parseReview` guard, the versioned rubric + skeptical system prompt, `renderReviewPrompt`.
- `packages/core/src/reviewers/aggregate.ts` — pure `aggregate(outcomes, opts) → IVerdict` + locus normalization.
- `packages/core/src/reviewers/registry.ts` — pure `resolvePanel(cfg, active) → IPanel` (independence + floor).
- `packages/core/src/reviewers/invoke.ts` — `reviewerInvoke(panel, request, deps) → ReviewOutcome[]` (parallel, fault-tolerant, injectable provider + binary runner).
- `packages/core/src/reviewers/harness-review.ts` — `gatherChange(deps, opts)` + `runHarnessReview(deps, opts)` orchestration, artifact write, exit-code decision.
- `packages/core/src/reviewers/index.ts` — barrel export.
- `packages/core/src/models-config.ts` — add `reviewPanel` to `IModelsConfig` + `parseReviewPanel`.
- `packages/core/src/cli/harness-review-mode.ts` — CLI arg parsing + real git/validate/binary/provider deps, calls `runHarnessReview`.
- `packages/core/src/cli.ts` — dispatch `harness-review` subcommand.
- `.githooks/pre-push` — path-filtered hook.
- `.github/workflows/harness-review.yml` — CI authority job.
- Tests: `packages/core/tests/reviewers-{schema,aggregate,registry,invoke,harness-review,config}.test.ts`.

---

## Task 1: Frozen schema, FindingCode, rubric, parseReview

**Files:**
- Create: `packages/core/src/reviewers/schema.ts`
- Test: `packages/core/tests/reviewers-schema.test.ts`

**Interfaces:**
- Produces:
  - `type Severity = "critical" | "major" | "minor"`
  - `const FINDING_CODES` (readonly tuple) / `type FindingCode`
  - `type ReviewVerdict = "approve" | "request-changes" | "reject"`
  - `interface IFinding { severity: Severity; findingCode: FindingCode; file?: string; line?: number; issue: string; fix?: string }`
  - `interface IReview { reviewerId: string; verdict: ReviewVerdict; findings: IFinding[]; summary: string }`
  - `interface IValidateSummary { passed: boolean; failCount: number; firstErrors: string[] }`
  - `interface IReviewRequest { title: string; intent: string; diff: string; validateSummary: IValidateSummary; contextFiles?: string[]; rubricVersion: string }`
  - `const RUBRIC_VERSION: string`, `const REVIEW_RUBRIC: string`, `const REVIEW_SYSTEM_PROMPT: string`
  - `function parseReview(reviewerId: string, raw: unknown): IReview | null`
  - `function renderReviewPrompt(req: IReviewRequest): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-schema.test.ts
import { test, expect, describe } from "bun:test";
import {
  parseReview,
  renderReviewPrompt,
  RUBRIC_VERSION,
  REVIEW_SYSTEM_PROMPT,
  type IReviewRequest,
} from "../src/reviewers/schema";

describe("parseReview", () => {
  test("accepts a well-formed review", () => {
    const r = parseReview("opus", {
      verdict: "request-changes",
      summary: "one issue",
      findings: [
        { severity: "major", findingCode: "as-cast", file: "a.ts", issue: "cast" },
      ],
    });

    expect(r).not.toBeNull();
    expect(r?.reviewerId).toBe("opus");
    expect(r?.findings[0]?.findingCode).toBe("as-cast");
  });

  test("returns null on an unknown verdict (parse fail, not silent approve)", () => {
    expect(parseReview("opus", { verdict: "lgtm", summary: "", findings: [] })).toBeNull();
  });

  test("returns null on an unknown findingCode", () => {
    const r = parseReview("opus", {
      verdict: "reject",
      summary: "x",
      findings: [{ severity: "critical", findingCode: "vibes", issue: "y" }],
    });

    expect(r).toBeNull();
  });

  test("returns null when findings is not an array", () => {
    expect(parseReview("opus", { verdict: "approve", summary: "", findings: {} })).toBeNull();
  });
});

describe("renderReviewPrompt", () => {
  test("embeds intent, diff, validate summary and the rubric version", () => {
    const req: IReviewRequest = {
      title: "t",
      intent: "add X",
      diff: "diff --git a b",
      validateSummary: { passed: true, failCount: 0, firstErrors: [] },
      rubricVersion: RUBRIC_VERSION,
    };
    const prompt = renderReviewPrompt(req);

    expect(prompt).toContain("add X");
    expect(prompt).toContain("diff --git a b");
    expect(REVIEW_SYSTEM_PROMPT).toContain("reject");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-schema.test.ts`
Expected: FAIL — `Cannot find module '../src/reviewers/schema'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/reviewers/schema.ts
import { isRecord } from "../lib/guards";

export type Severity = "critical" | "major" | "minor";

export const FINDING_CODES = [
  "missing-test",
  "as-cast",
  "non-null-assert",
  "gate-relaxed",
  "complexity",
  "scope-bypass",
  "security",
  "supply-chain",
  "dead-code",
  "wrong-idiom",
  "other",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export type ReviewVerdict = "approve" | "request-changes" | "reject";

export interface IFinding {
  severity: Severity;
  findingCode: FindingCode;
  file?: string;
  line?: number;
  issue: string;
  fix?: string;
}

export interface IReview {
  reviewerId: string;
  verdict: ReviewVerdict;
  findings: IFinding[];
  summary: string;
}

export interface IValidateSummary {
  passed: boolean;
  failCount: number;
  firstErrors: string[];
}

/** FROZEN — Phase 2 reuses this unchanged. */
export interface IReviewRequest {
  title: string;
  intent: string;
  diff: string;
  validateSummary: IValidateSummary;
  contextFiles?: string[];
  rubricVersion: string;
}

export const RUBRIC_VERSION = "1";

export const REVIEW_RUBRIC = [
  "House rules the change MUST satisfy:",
  "- No `as` casts (except `as const`); no non-null `!`; no `any`.",
  "- Cognitive complexity <= 20 per function; extract helpers instead of raising it.",
  "- Every changed code file has a mirrored test; new behavior is tested.",
  "- The gate is never relaxed (no downgraded severities/thresholds, no disabled rules).",
  "- Tools/reviewers stay independent; no self-review shortcuts.",
  "- No silent truncation, no dead code, no scope bypass.",
].join("\n");

export const REVIEW_SYSTEM_PROMPT = [
  "You are an independent, skeptical code reviewer. Default to reject when unsure.",
  "You are reviewing a change to a build harness. Find real defects, not style nits.",
  "Respond with ONE JSON object and nothing else:",
  '{ "verdict": "approve"|"request-changes"|"reject",',
  '  "summary": string,',
  '  "findings": [ { "severity": "critical"|"major"|"minor",',
  `    "findingCode": one of ${FINDING_CODES.join("|")},`,
  '    "file"?: string, "line"?: number, "issue": string, "fix"?: string } ] }',
  "",
  REVIEW_RUBRIC,
].join("\n");

function isSeverity(v: unknown): v is Severity {
  return v === "critical" || v === "major" || v === "minor";
}

function isFindingCode(v: unknown): v is FindingCode {
  return typeof v === "string" && FINDING_CODES.some((c) => c === v);
}

function isVerdict(v: unknown): v is ReviewVerdict {
  return v === "approve" || v === "request-changes" || v === "reject";
}

function parseFinding(raw: unknown): IFinding | null {
  if (!isRecord(raw) || !isSeverity(raw.severity) || !isFindingCode(raw.findingCode)) {
    return null;
  }

  if (typeof raw.issue !== "string") {
    return null;
  }

  const finding: IFinding = {
    severity: raw.severity,
    findingCode: raw.findingCode,
    issue: raw.issue,
  };

  if (typeof raw.file === "string") {
    finding.file = raw.file;
  }

  if (typeof raw.line === "number") {
    finding.line = raw.line;
  }

  if (typeof raw.fix === "string") {
    finding.fix = raw.fix;
  }

  return finding;
}

/** Validate a model/binary's raw JSON into an IReview. Returns null on ANY
 *  malformation — the caller records that reviewer as `errored`, never as an
 *  approval, so a parse failure can't sneak through as a pass. */
export function parseReview(reviewerId: string, raw: unknown): IReview | null {
  if (!isRecord(raw) || !isVerdict(raw.verdict) || typeof raw.summary !== "string") {
    return null;
  }

  if (!Array.isArray(raw.findings)) {
    return null;
  }

  const findings: IFinding[] = [];

  for (const f of raw.findings) {
    const parsed = parseFinding(f);

    if (parsed === null) {
      return null;
    }

    findings.push(parsed);
  }

  return { reviewerId, verdict: raw.verdict, findings, summary: raw.summary };
}

export function renderReviewPrompt(req: IReviewRequest): string {
  const validate = req.validateSummary.passed
    ? "validate: PASSED"
    : `validate: FAILED (${String(req.validateSummary.failCount)} errors)\n${req.validateSummary.firstErrors.join("\n")}`;

  return [
    `# Change under review: ${req.title}`,
    `Rubric version: ${req.rubricVersion}`,
    "",
    "## Intent",
    req.intent,
    "",
    `## ${validate}`,
    "",
    "## Diff",
    req.diff,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-schema.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd /Users/ag/Documents/Code/tsforge
git add packages/core/src/reviewers/schema.ts packages/core/tests/reviewers-schema.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): frozen review schema + rubric + parseReview guard"
```

---

## Task 2: `reviewPanel` config block

**Files:**
- Modify: `packages/core/src/models-config.ts` (add types + `parseReviewPanel`, call it in `parseModelsConfig`)
- Test: `packages/core/tests/reviewers-config.test.ts`

**Interfaces:**
- Consumes: `IModelEntry`, `Record<string, IModelEntry>` (existing).
- Produces:
  - `interface IReviewerModel { kind: "model"; id: string; entry: string }`
  - `type BinaryInputMode = "stdin" | "arg" | "tempfile"`
  - `type BinaryParseMode = "json-fence" | "raw"`
  - `interface IReviewerBinary { kind: "binary"; id: string; argv: string[]; input: BinaryInputMode; timeoutMs: number; parse: BinaryParseMode }`
  - `type IReviewer = IReviewerModel | IReviewerBinary`
  - `interface IReviewPanel { minReviewers: number; reviewers: IReviewer[] }`
  - `IModelsConfig` gains `reviewPanel?: IReviewPanel`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-config.test.ts
import { test, expect, describe } from "bun:test";
import { parseModelsConfig } from "../src/models-config";

const base = {
  active: "local",
  models: { local: { baseUrl: "http://x/v1", model: "m" }, opus: { baseUrl: "http://y/v1", model: "opus" } },
};

describe("parseModelsConfig reviewPanel", () => {
  test("parses a model + binary panel", () => {
    const cfg = parseModelsConfig({
      ...base,
      reviewPanel: {
        minReviewers: 2,
        reviewers: [
          { kind: "model", id: "opus", entry: "opus" },
          { kind: "binary", id: "grok", argv: ["grok", "-p"], input: "arg", timeoutMs: 180000, parse: "json-fence" },
        ],
      },
    });

    expect(cfg.reviewPanel?.reviewers).toHaveLength(2);
  });

  test("rejects a model reviewer whose entry is not a known model", () => {
    expect(() =>
      parseModelsConfig({
        ...base,
        reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "x", entry: "ghost" }] },
      })
    ).toThrow(/entry "ghost"/u);
  });

  test("rejects a binary reviewer with an empty argv", () => {
    expect(() =>
      parseModelsConfig({
        ...base,
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ kind: "binary", id: "b", argv: [], input: "arg", timeoutMs: 1000, parse: "raw" }],
        },
      })
    ).toThrow(/argv/u);
  });

  test("a config with no reviewPanel still parses", () => {
    expect(parseModelsConfig(base).reviewPanel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-config.test.ts`
Expected: FAIL — `reviewPanel` is `undefined` on the first case (types/parse not added).

- [ ] **Step 3: Write the implementation**

Add the types after `IModelsConfig` (near models-config.ts:76):

```ts
export interface IReviewerModel {
  kind: "model";
  id: string;
  /** Names a key in `models` — reuses its baseUrl/key/headers. */
  entry: string;
}

export type BinaryInputMode = "stdin" | "arg" | "tempfile";
export type BinaryParseMode = "json-fence" | "raw";

export interface IReviewerBinary {
  kind: "binary";
  id: string;
  argv: string[];
  input: BinaryInputMode;
  timeoutMs: number;
  parse: BinaryParseMode;
}

export type IReviewer = IReviewerModel | IReviewerBinary;

export interface IReviewPanel {
  minReviewers: number;
  reviewers: IReviewer[];
}
```

Add `reviewPanel?: IReviewPanel;` to `IModelsConfig`.

Add the validator (uses `isRecord`; each branch small to keep complexity low):

```ts
function isInputMode(v: unknown): v is BinaryInputMode {
  return v === "stdin" || v === "arg" || v === "tempfile";
}

function isParseMode(v: unknown): v is BinaryParseMode {
  return v === "json-fence" || v === "raw";
}

function parseModelReviewer(raw: Record<string, unknown>, models: Record<string, IModelEntry>): IReviewerModel {
  if (typeof raw.id !== "string" || typeof raw.entry !== "string") {
    throw new Error('models.json: model reviewer needs { id, entry }');
  }

  if (models[raw.entry] === undefined) {
    throw new Error(`models.json: reviewer entry "${raw.entry}" is not a configured model`);
  }

  return { kind: "model", id: raw.id, entry: raw.entry };
}

function parseBinaryReviewer(raw: Record<string, unknown>): IReviewerBinary {
  const argv = raw.argv;

  if (typeof raw.id !== "string" || !Array.isArray(argv) || argv.length === 0) {
    throw new Error("models.json: binary reviewer needs { id, argv (non-empty) }");
  }

  if (!argv.every((a): a is string => typeof a === "string")) {
    throw new Error("models.json: binary reviewer argv must be all strings");
  }

  if (!isInputMode(raw.input) || !isParseMode(raw.parse) || typeof raw.timeoutMs !== "number") {
    throw new Error("models.json: binary reviewer needs { input, parse, timeoutMs }");
  }

  return { kind: "binary", id: raw.id, argv, input: raw.input, timeoutMs: raw.timeoutMs, parse: raw.parse };
}

function parseReviewer(raw: unknown, models: Record<string, IModelEntry>): IReviewer {
  if (!isRecord(raw)) {
    throw new Error("models.json: each reviewer must be an object");
  }

  if (raw.kind === "model") {
    return parseModelReviewer(raw, models);
  }

  if (raw.kind === "binary") {
    return parseBinaryReviewer(raw);
  }

  throw new Error('models.json: reviewer kind must be "model" or "binary"');
}

function parseReviewPanel(raw: unknown, models: Record<string, IModelEntry>): IReviewPanel | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isRecord(raw) || !Array.isArray(raw.reviewers)) {
    throw new Error("models.json: reviewPanel must be { minReviewers, reviewers[] }");
  }

  const minReviewers = typeof raw.minReviewers === "number" ? raw.minReviewers : 2;
  const reviewers = raw.reviewers.map((r) => parseReviewer(r, models));

  return { minReviewers, reviewers };
}
```

In `parseModelsConfig`, after the `capabilities` block, resolve the panel and include it:

```ts
  const reviewPanel = parseReviewPanel(raw.reviewPanel, models);
  const withCaps = capabilities === undefined
    ? { active: raw.active, models }
    : { active: raw.active, models, capabilities };

  return reviewPanel === undefined ? withCaps : { ...withCaps, reviewPanel };
```

(Replace the existing `return capabilities === undefined ? … : …` at models-config.ts:183-185 with the block above.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Run existing config tests (no regression) + commit**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/*models-config* 2>/dev/null; bun test packages/core/tests/reviewers-config.test.ts`
Expected: PASS.

```bash
git add packages/core/src/models-config.ts packages/core/tests/reviewers-config.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): reviewPanel config block (model + binary reviewers)"
```

---

## Task 3: Registry — resolve panel, enforce independence, floor minReviewers

**Files:**
- Create: `packages/core/src/reviewers/registry.ts`
- Test: `packages/core/tests/reviewers-registry.test.ts`

**Interfaces:**
- Consumes: `IModelsConfig`, `IModelEntry`, `IReviewer` (Task 2); `IReviewRequest` unused here.
- Produces:
  - `type ResolvedReviewer = { kind: "model"; id: string; entry: IModelEntry } | { kind: "binary"; id: string; argv: string[]; input: BinaryInputMode; timeoutMs: number; parse: BinaryParseMode }`
  - `interface IPanel { reviewers: ResolvedReviewer[]; minReviewers: number; skipped: { id: string; reason: string }[] }`
  - `function resolvePanel(cfg: IModelsConfig, active: { name: string; entry: IModelEntry }): IPanel`
  - `const MIN_REVIEWERS_FLOOR = 2`

**Independence rule (verbatim):** a model reviewer is skipped when its entry name equals `active.name`, OR its normalized `(host, model)` equals the active model's. Host = the lowercased hostname of `baseUrl` (parsed; on parse failure, the raw lowercased string). Binaries are always independent (different process/vendor).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-registry.test.ts
import { test, expect, describe } from "bun:test";
import { resolvePanel, MIN_REVIEWERS_FLOOR } from "../src/reviewers/registry";
import type { IModelsConfig } from "../src/models-config";

function cfg(over: Partial<IModelsConfig>): IModelsConfig {
  return {
    active: "local",
    models: {
      local: { baseUrl: "http://host-a/v1", model: "flash" },
      opus: { baseUrl: "http://host-b/v1", model: "opus" },
      cloneAlias: { baseUrl: "http://host-a/v1", model: "flash" },
    },
    ...over,
  };
}

const active = { name: "local", entry: { baseUrl: "http://host-a/v1", model: "flash" } };

describe("resolvePanel independence", () => {
  test("keeps an independent model reviewer", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "opus", entry: "opus" }] } }),
      active
    );

    expect(p.reviewers.map((r) => r.id)).toEqual(["opus"]);
    expect(p.skipped).toEqual([]);
  });

  test("skips the active entry by name", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "self", entry: "local" }] } }),
      active
    );

    expect(p.reviewers).toEqual([]);
    expect(p.skipped[0]?.id).toBe("self");
  });

  test("skips a same-weights alias (same host+model, different entry name)", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "sneaky", entry: "cloneAlias" }] } }),
      active
    );

    expect(p.reviewers).toEqual([]);
    expect(p.skipped[0]?.reason).toMatch(/same model as the builder/u);
  });

  test("binaries are always kept", () => {
    const p = resolvePanel(
      cfg({
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ kind: "binary", id: "grok", argv: ["grok"], input: "arg", timeoutMs: 1000, parse: "raw" }],
        },
      }),
      active
    );

    expect(p.reviewers.map((r) => r.id)).toEqual(["grok"]);
  });

  test("minReviewers is floored at 2 even if config says 1", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 1, reviewers: [{ kind: "model", id: "opus", entry: "opus" }] } }),
      active
    );

    expect(p.minReviewers).toBe(MIN_REVIEWERS_FLOOR);
  });

  test("no panel configured → empty reviewers, floored minReviewers", () => {
    const p = resolvePanel(cfg({}), active);

    expect(p.reviewers).toEqual([]);
    expect(p.minReviewers).toBe(MIN_REVIEWERS_FLOOR);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/reviewers/registry.ts
import type {
  IModelsConfig,
  IModelEntry,
  IReviewer,
  BinaryInputMode,
  BinaryParseMode,
} from "../models-config";

export const MIN_REVIEWERS_FLOOR = 2;

export type ResolvedReviewer =
  | { kind: "model"; id: string; entry: IModelEntry }
  | {
      kind: "binary";
      id: string;
      argv: string[];
      input: BinaryInputMode;
      timeoutMs: number;
      parse: BinaryParseMode;
    };

export interface IPanel {
  reviewers: ResolvedReviewer[];
  minReviewers: number;
  skipped: { id: string; reason: string }[];
}

/** Lowercased hostname of a base URL; the raw lowercased string if it won't parse. */
function normHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

function sameModel(a: IModelEntry, b: IModelEntry): boolean {
  return normHost(a.baseUrl) === normHost(b.baseUrl) && a.model.toLowerCase() === b.model.toLowerCase();
}

interface IIndependence {
  ok: boolean;
  reason: string;
}

function checkModelIndependence(
  entryName: string,
  entry: IModelEntry,
  active: { name: string; entry: IModelEntry }
): IIndependence {
  if (entryName === active.name) {
    return { ok: false, reason: "reviewer is the active builder entry" };
  }

  if (sameModel(entry, active.entry)) {
    return { ok: false, reason: "reviewer is the same model as the builder (same host + model id)" };
  }

  return { ok: true, reason: "" };
}

function resolveOne(
  reviewer: IReviewer,
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): { kept?: ResolvedReviewer; skipped?: { id: string; reason: string } } {
  if (reviewer.kind === "binary") {
    return {
      kept: {
        kind: "binary",
        id: reviewer.id,
        argv: reviewer.argv,
        input: reviewer.input,
        timeoutMs: reviewer.timeoutMs,
        parse: reviewer.parse,
      },
    };
  }

  const entry = cfg.models[reviewer.entry];

  if (entry === undefined) {
    return { skipped: { id: reviewer.id, reason: `entry "${reviewer.entry}" not in models` } };
  }

  const independence = checkModelIndependence(reviewer.entry, entry, active);

  return independence.ok
    ? { kept: { kind: "model", id: reviewer.id, entry } }
    : { skipped: { id: reviewer.id, reason: independence.reason } };
}

export function resolvePanel(
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): IPanel {
  const panel = cfg.reviewPanel;
  const minReviewers = Math.max(MIN_REVIEWERS_FLOOR, panel?.minReviewers ?? MIN_REVIEWERS_FLOOR);
  const reviewers: ResolvedReviewer[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const r of panel?.reviewers ?? []) {
    const { kept, skipped: skip } = resolveOne(r, cfg, active);

    if (kept !== undefined) {
      reviewers.push(kept);
    }

    if (skip !== undefined) {
      skipped.push(skip);
    }
  }

  return { reviewers, minReviewers, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reviewers/registry.ts packages/core/tests/reviewers-registry.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): registry with independence check + minReviewers floor"
```

---

## Task 4: Deterministic aggregator

**Files:**
- Create: `packages/core/src/reviewers/aggregate.ts`
- Test: `packages/core/tests/reviewers-aggregate.test.ts`

**Interfaces:**
- Consumes: `IReview`, `IFinding` (Task 1).
- Produces:
  - `type ReviewOutcome = { status: "ok"; review: IReview } | { status: "errored"; reviewerId: string; error: string }`
  - `interface IRankedFinding extends IFinding { agreement: number }`
  - `interface IVerdict { blocked: boolean; reason: string; reviewers: { ok: number; errored: number }; ranked: IRankedFinding[]; perReviewer: IReview[]; identity: string }`
  - `function aggregate(outcomes: ReviewOutcome[], opts: { minReviewers: number; identity: string }): IVerdict`

**Block rules (in order; first match sets the reason):**
1. `ok < minReviewers` → "insufficient reviewers (N of M)".
2. any `reject` → "a reviewer rejected the change".
3. any single `critical` finding with `findingCode` in `{security, supply-chain}` → "critical security finding".
4. any locus with ≥2 reviewers raising `critical|major` → "N reviewers agree on a serious finding".
5. majority of ok reviewers `request-changes|reject` AND at least one `major` present → "majority requested changes with a major finding".
6. else pass.

**Locus** = `` `${normFile}::${findingCode}` `` when `findingCode !== "other"`, else `` `${normFile}::${normIssue}` ``. `normFile`: strip leading `a/`/`b/`, backslashes→`/`, lowercased. `normIssue`: lowercased, whitespace collapsed, leading `the `/`a `/`an ` stripped, capped 120 chars. Missing `file` → `"<no-file>"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-aggregate.test.ts
import { test, expect, describe } from "bun:test";
import { aggregate, type ReviewOutcome } from "../src/reviewers/aggregate";
import type { IReview, IFinding } from "../src/reviewers/schema";

function ok(id: string, verdict: IReview["verdict"], findings: IFinding[] = []): ReviewOutcome {
  return { status: "ok", review: { reviewerId: id, verdict, findings, summary: "" } };
}

const opts = { minReviewers: 2, identity: "local/flash" };

describe("aggregate", () => {
  test("all approve → pass", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "approve")], opts);

    expect(v.blocked).toBe(false);
    expect(v.reviewers).toEqual({ ok: 2, errored: 0 });
  });

  test("insufficient reviewers → block", () => {
    const v = aggregate([ok("a", "approve"), { status: "errored", reviewerId: "b", error: "timeout" }], opts);

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/insufficient reviewers/u);
    expect(v.reviewers).toEqual({ ok: 1, errored: 1 });
  });

  test("any reject → block", () => {
    const v = aggregate([ok("a", "approve"), ok("b", "reject")], opts);

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/rejected/u);
  });

  test("single critical security finding → block", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [{ severity: "critical", findingCode: "security", file: "s.ts", issue: "ssrf" }]),
        ok("b", "approve"),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/critical security/u);
  });

  test("two reviewers agree on a major at same locus → block", () => {
    const f: IFinding = { severity: "major", findingCode: "as-cast", file: "a.ts", issue: "cast here" };
    const v = aggregate([ok("a", "request-changes", [f]), ok("b", "request-changes", [{ ...f }])], opts);

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
    expect(v.reason).toMatch(/agree/u);
  });

  test("majority request-changes with a major but no locus agreement → block", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [{ severity: "major", findingCode: "missing-test", file: "a.ts", issue: "no test" }]),
        ok("b", "request-changes", [{ severity: "major", findingCode: "dead-code", file: "b.ts", issue: "unused" }]),
        ok("c", "approve"),
      ],
      { minReviewers: 2, identity: "x" }
    );

    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/majority/u);
  });

  test("locus keys on findingCode, not exact line (different lines still agree)", () => {
    const v = aggregate(
      [
        ok("a", "request-changes", [{ severity: "major", findingCode: "as-cast", file: "a.ts", line: 10, issue: "x" }]),
        ok("b", "request-changes", [{ severity: "major", findingCode: "as-cast", file: "a.ts", line: 99, issue: "y" }]),
      ],
      opts
    );

    expect(v.blocked).toBe(true);
    expect(v.ranked[0]?.agreement).toBe(2);
  });

  test("one minor finding, both approve → pass", () => {
    const v = aggregate(
      [ok("a", "approve", [{ severity: "minor", findingCode: "other", file: "a.ts", issue: "nit" }]), ok("b", "approve")],
      opts
    );

    expect(v.blocked).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/reviewers/aggregate.ts
import type { IReview, IFinding, FindingCode } from "./schema";

export type ReviewOutcome =
  | { status: "ok"; review: IReview }
  | { status: "errored"; reviewerId: string; error: string };

export interface IRankedFinding extends IFinding {
  agreement: number;
}

export interface IVerdict {
  blocked: boolean;
  reason: string;
  reviewers: { ok: number; errored: number };
  ranked: IRankedFinding[];
  perReviewer: IReview[];
  identity: string;
}

const SECURITY_CODES: readonly FindingCode[] = ["security", "supply-chain"];
const SEVERITY_RANK: Record<IFinding["severity"], number> = { critical: 3, major: 2, minor: 1 };

function normFile(file: string | undefined): string {
  if (file === undefined) {
    return "<no-file>";
  }

  return file.replace(/\\/gu, "/").replace(/^[ab]\//u, "").toLowerCase();
}

function normIssue(issue: string): string {
  return issue
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^(?:the|a|an) /u, "")
    .trim()
    .slice(0, 120);
}

function locusKey(f: IFinding): string {
  const file = normFile(f.file);

  return f.findingCode === "other" ? `${file}::${normIssue(f.issue)}` : `${file}::${f.findingCode}`;
}

interface IGroup {
  finding: IFinding;
  reviewers: Set<string>;
}

function groupFindings(reviews: IReview[]): Map<string, IGroup> {
  const groups = new Map<string, IGroup>();

  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = locusKey(finding);
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, { finding, reviewers: new Set([review.reviewerId]) });
      } else {
        existing.reviewers.add(review.reviewerId);

        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.finding.severity]) {
          existing.finding = finding;
        }
      }
    }
  }

  return groups;
}

function rank(groups: Map<string, IGroup>): IRankedFinding[] {
  const ranked: IRankedFinding[] = [];

  for (const g of groups.values()) {
    ranked.push({ ...g.finding, agreement: g.reviewers.size });
  }

  return ranked.sort(
    (a, b) => SEVERITY_RANK[b.severity] * b.agreement - SEVERITY_RANK[a.severity] * a.agreement
  );
}

function isSerious(f: IFinding): boolean {
  return f.severity === "critical" || f.severity === "major";
}

function decideReason(
  reviews: IReview[],
  ranked: IRankedFinding[],
  okCount: number,
  minReviewers: number
): string {
  if (okCount < minReviewers) {
    return `insufficient reviewers (${String(okCount)} of ${String(minReviewers)} required)`;
  }

  if (reviews.some((r) => r.verdict === "reject")) {
    return "a reviewer rejected the change";
  }

  const criticalSecurity = ranked.find(
    (f) => f.severity === "critical" && SECURITY_CODES.some((c) => c === f.findingCode)
  );

  if (criticalSecurity !== undefined) {
    return `critical security finding: ${criticalSecurity.issue}`;
  }

  const agreedSerious = ranked.find((f) => f.agreement >= 2 && isSerious(f));

  if (agreedSerious !== undefined) {
    return `${String(agreedSerious.agreement)} reviewers agree on a serious finding: ${agreedSerious.issue}`;
  }

  const wantsChange = reviews.filter((r) => r.verdict !== "approve").length;
  const hasMajor = reviews.some((r) => r.findings.some(isSerious));

  if (wantsChange * 2 > reviews.length && hasMajor) {
    return "majority requested changes with a major finding";
  }

  return "";
}

export function aggregate(
  outcomes: ReviewOutcome[],
  opts: { minReviewers: number; identity: string }
): IVerdict {
  const reviews: IReview[] = [];
  let errored = 0;

  for (const o of outcomes) {
    if (o.status === "ok") {
      reviews.push(o.review);
    } else {
      errored += 1;
    }
  }

  const ranked = rank(groupFindings(reviews));
  const reason = decideReason(reviews, ranked, reviews.length, opts.minReviewers);

  return {
    blocked: reason.length > 0,
    reason: reason.length > 0 ? reason : "all reviewers approved",
    reviewers: { ok: reviews.length, errored },
    ranked,
    perReviewer: reviews,
    identity: opts.identity,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-aggregate.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reviewers/aggregate.ts packages/core/tests/reviewers-aggregate.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): deterministic aggregate with locus-agreement + security rules"
```

---

## Task 5: Parallel invocation (model + binary), fault-tolerant

**Files:**
- Create: `packages/core/src/reviewers/invoke.ts`
- Test: `packages/core/tests/reviewers-invoke.test.ts`

**Interfaces:**
- Consumes: `IPanel`, `ResolvedReviewer` (Task 3); `IReviewRequest`, `REVIEW_SYSTEM_PROMPT`, `renderReviewPrompt`, `parseReview` (Task 1); `ReviewOutcome` (Task 4); `IProvider`, `IModelEntry` (inference/models-config); `extractJson` (lib/json).
- Produces:
  - `interface IInvokeDeps { makeProvider: (entry: IModelEntry) => IProvider; runBinary: (r: { argv: string[]; input: BinaryInputMode; timeoutMs: number }, stdin: string) => Promise<{ ok: boolean; stdout: string }> }`
  - `function reviewerInvoke(panel: IPanel, request: IReviewRequest, deps: IInvokeDeps): Promise<ReviewOutcome[]>`
  - `const REVIEWER_CONCURRENCY = 5`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-invoke.test.ts
import { test, expect, describe } from "bun:test";
import { reviewerInvoke, type IInvokeDeps } from "../src/reviewers/invoke";
import type { IPanel } from "../src/reviewers/registry";
import type { IReviewRequest } from "../src/reviewers/schema";
import type { IProvider } from "../src/inference";

const request: IReviewRequest = {
  title: "t",
  intent: "i",
  diff: "d",
  validateSummary: { passed: true, failCount: 0, firstErrors: [] },
  rubricVersion: "1",
};

function jsonProvider(body: unknown): IProvider {
  return { async complete() { return { content: JSON.stringify(body), toolCalls: [] }; } };
}

function panelWith(...reviewers: IPanel["reviewers"]): IPanel {
  return { reviewers, minReviewers: 2, skipped: [] };
}

describe("reviewerInvoke", () => {
  test("a model reviewer returning valid JSON → ok outcome", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({ verdict: "approve", summary: "", findings: [] }),
      runBinary: async () => ({ ok: true, stdout: "" }),
    };
    const out = await reviewerInvoke(panelWith({ kind: "model", id: "opus", entry: { baseUrl: "http://x/v1", model: "m" } }), request, deps);

    expect(out[0]?.status).toBe("ok");
  });

  test("a reviewer that throws → errored (others still returned)", async () => {
    const throwing: IProvider = { async complete() { throw new Error("boom"); } };
    const deps: IInvokeDeps = {
      makeProvider: (e) => (e.model === "bad" ? throwing : jsonProvider({ verdict: "approve", summary: "", findings: [] })),
      runBinary: async () => ({ ok: true, stdout: "" }),
    };
    const out = await reviewerInvoke(
      panelWith(
        { kind: "model", id: "bad", entry: { baseUrl: "http://x/v1", model: "bad" } },
        { kind: "model", id: "good", entry: { baseUrl: "http://y/v1", model: "good" } }
      ),
      request,
      deps
    );
    const byId = Object.fromEntries(out.map((o) => [o.status === "ok" ? o.review.reviewerId : o.reviewerId, o.status]));

    expect(byId.bad).toBe("errored");
    expect(byId.good).toBe("ok");
  });

  test("malformed JSON from a reviewer → errored, not a silent approve", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () => ({ async complete() { return { content: "not json", toolCalls: [] }; } }),
      runBinary: async () => ({ ok: true, stdout: "" }),
    };
    const out = await reviewerInvoke(panelWith({ kind: "model", id: "m", entry: { baseUrl: "http://x/v1", model: "m" } }), request, deps);

    expect(out[0]?.status).toBe("errored");
  });

  test("a binary reviewer: json-fence output is parsed", async () => {
    const fenced = "reasoning...\n```json\n{\"verdict\":\"reject\",\"summary\":\"no\",\"findings\":[]}\n```\n";
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({}),
      runBinary: async () => ({ ok: true, stdout: fenced }),
    };
    const out = await reviewerInvoke(
      panelWith({ kind: "binary", id: "grok", argv: ["grok"], input: "arg", timeoutMs: 1000, parse: "json-fence" }),
      request,
      deps
    );

    expect(out[0]).toEqual({ status: "ok", review: { reviewerId: "grok", verdict: "reject", findings: [], summary: "no" } });
  });

  test("a binary that exits non-zero → errored", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({}),
      runBinary: async () => ({ ok: false, stdout: "" }),
    };
    const out = await reviewerInvoke(
      panelWith({ kind: "binary", id: "grok", argv: ["grok"], input: "arg", timeoutMs: 1000, parse: "raw" }),
      request,
      deps
    );

    expect(out[0]?.status).toBe("errored");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-invoke.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/reviewers/invoke.ts
import type { IProvider } from "../inference";
import type { IModelEntry, BinaryInputMode } from "../models-config";
import { extractJson } from "../lib/json/json";
import type { IPanel, ResolvedReviewer } from "./registry";
import {
  parseReview,
  renderReviewPrompt,
  REVIEW_SYSTEM_PROMPT,
  type IReview,
  type IReviewRequest,
} from "./schema";
import type { ReviewOutcome } from "./aggregate";

export const REVIEWER_CONCURRENCY = 5;

export interface IInvokeDeps {
  makeProvider: (entry: IModelEntry) => IProvider;
  runBinary: (
    r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
    stdin: string
  ) => Promise<{ ok: boolean; stdout: string }>;
}

function reviewFrom(id: string, rawText: string): ReviewOutcome {
  let review: IReview | null;

  try {
    review = parseReview(id, JSON.parse(extractJson(rawText)));
  } catch {
    review = null;
  }

  return review === null
    ? { status: "errored", reviewerId: id, error: "unparseable review output" }
    : { status: "ok", review };
}

async function invokeModel(
  reviewer: Extract<ResolvedReviewer, { kind: "model" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  try {
    const res = await deps.makeProvider(reviewer.entry).complete([
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: renderReviewPrompt(request) },
    ]);

    return reviewFrom(reviewer.id, res.content);
  } catch (err) {
    return { status: "errored", reviewerId: reviewer.id, error: err instanceof Error ? err.message : String(err) };
  }
}

/** For `json-fence`, extract the last ```json block; for `raw`, use stdout as-is.
 *  Both then flow through the same JSON+schema guard, so a fence miss → errored. */
function extractBinaryJson(stdout: string): string {
  const matches = [...stdout.matchAll(/```json\s*([\s\S]*?)```/gu)];
  const last = matches.at(-1);

  return last?.[1] ?? stdout;
}

async function invokeBinary(
  reviewer: Extract<ResolvedReviewer, { kind: "binary" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  try {
    const stdin = renderReviewPrompt(request);
    const res = await deps.runBinary(
      { argv: reviewer.argv, input: reviewer.input, timeoutMs: reviewer.timeoutMs },
      stdin
    );

    if (!res.ok) {
      return { status: "errored", reviewerId: reviewer.id, error: "binary exited non-zero or timed out" };
    }

    const payload = reviewer.parse === "json-fence" ? extractBinaryJson(res.stdout) : res.stdout;

    return reviewFrom(reviewer.id, payload);
  } catch (err) {
    return { status: "errored", reviewerId: reviewer.id, error: err instanceof Error ? err.message : String(err) };
  }
}

function invokeOne(r: ResolvedReviewer, request: IReviewRequest, deps: IInvokeDeps): Promise<ReviewOutcome> {
  return r.kind === "model" ? invokeModel(r, request, deps) : invokeBinary(r, request, deps);
}

/** Run all reviewers with a small concurrency cap; every reviewer resolves to an
 *  outcome (never rejects) so one failure can't sink the panel. */
export async function reviewerInvoke(
  panel: IPanel,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome[]> {
  const queue = [...panel.reviewers];
  const results: ReviewOutcome[] = [];

  async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.push(await invokeOne(next, request, deps));
    }
  }

  const workers = Array.from({ length: Math.min(REVIEWER_CONCURRENCY, panel.reviewers.length) }, () => worker());

  await Promise.all(workers);

  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-invoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the barrel + commit**

Create `packages/core/src/reviewers/index.ts`:

```ts
export * from "./schema";
export * from "./aggregate";
export * from "./registry";
export * from "./invoke";
export * from "./harness-review";
```

(The `./harness-review` export lands in Task 6; add it there if this step runs first — if the file doesn't exist yet, omit that line and add it in Task 6.)

```bash
git add packages/core/src/reviewers/invoke.ts packages/core/src/reviewers/index.ts packages/core/tests/reviewers-invoke.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): parallel fault-tolerant model+binary invocation"
```

---

## Task 6: Orchestrator — gather (diff/intent/validate/budget) + run

**Files:**
- Create: `packages/core/src/reviewers/harness-review.ts`
- Test: `packages/core/tests/reviewers-harness-review.test.ts`

**Interfaces:**
- Consumes: everything above; injectable git/validate runners so tests never touch real git or the network.
- Produces:
  - `interface IGitRunner { (args: string[]): Promise<{ stdout: string; code: number }> }`
  - `interface IValidateRunner { (): Promise<IValidateSummary> }`
  - `interface IGatherDeps { git: IGitRunner; validate: IValidateRunner }`
  - `interface IGatherOptions { base?: string; intent?: string; maxFiles: number; maxChars: number }`
  - `type GatherResult = { kind: "request"; request: IReviewRequest } | { kind: "block"; reason: string }`
  - `function gatherChange(deps: IGatherDeps, opts: IGatherOptions): Promise<GatherResult>`
  - `interface IRunDeps extends IGatherDeps, IInvokeDeps { panel: IPanel; identity: string }`
  - `function runHarnessReview(deps: IRunDeps, opts: IGatherOptions): Promise<IVerdict>`
- `const GENERIC_INTENTS = ["wip", "fix", "wip fix", "update", "changes"]`, `const DEFAULT_MAX_FILES = 40`, `const DEFAULT_MAX_CHARS = 120000`.

**Intent priority:** `opts.intent` > (`git log -1 --format=%s%n%b` when its subject is non-generic) > BLOCK requesting `--intent`. **Validate first:** `!passed` → BLOCK (panel not spent). **Budget:** changed-file count > maxFiles OR diff length > maxChars → BLOCK ("split the PR").

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-harness-review.test.ts
import { test, expect, describe } from "bun:test";
import { gatherChange, runHarnessReview, type IGatherDeps, type IRunDeps } from "../src/reviewers/harness-review";
import type { IPanel } from "../src/reviewers/registry";

function git(map: Record<string, string>): IGatherDeps["git"] {
  return async (args) => {
    const key = args.join(" ");
    const hit = Object.entries(map).find(([k]) => key.includes(k));

    return { stdout: hit?.[1] ?? "", code: 0 };
  };
}

const cleanValidate = async () => ({ passed: true, failCount: 0, firstErrors: [] });
const opts = { maxFiles: 40, maxChars: 120000, intent: "add feature X" };

describe("gatherChange", () => {
  test("validate red → block, panel not needed", async () => {
    const deps: IGatherDeps = {
      git: git({ "diff": "diff --git a/x b/x\n+code", "diff --name-only": "x.ts" }),
      validate: async () => ({ passed: false, failCount: 3, firstErrors: ["TS2345 ..."] }),
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("block");
    if (r.kind === "block") {
      expect(r.reason).toMatch(/validate/iu);
    }
  });

  test("no intent and a generic commit subject → block asking for --intent", async () => {
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": "x.ts", "diff": "+x", "log -1": "wip" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, { maxFiles: 40, maxChars: 120000 });

    expect(r.kind).toBe("block");
    if (r.kind === "block") {
      expect(r.reason).toMatch(/intent/iu);
    }
  });

  test("over the file budget → block asking to split", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${String(i)}.ts`).join("\n");
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": names, "diff": "+x" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("block");
    if (r.kind === "block") {
      expect(r.reason).toMatch(/split/iu);
    }
  });

  test("clean small change with intent → a request", async () => {
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": "x.ts", "diff": "diff --git a/x b/x\n+code" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("request");
    if (r.kind === "request") {
      expect(r.request.intent).toBe("add feature X");
      expect(r.request.validateSummary.passed).toBe(true);
    }
  });
});

describe("runHarnessReview", () => {
  test("a blocked gather short-circuits to a blocked verdict without invoking reviewers", async () => {
    let invoked = false;
    const panel: IPanel = { reviewers: [], minReviewers: 2, skipped: [] };
    const deps: IRunDeps = {
      git: git({ "diff --name-only": "x.ts", "diff": "+x" }),
      validate: async () => ({ passed: false, failCount: 1, firstErrors: ["boom"] }),
      makeProvider: () => { invoked = true; return { async complete() { return { content: "", toolCalls: [] }; } }; },
      runBinary: async () => { invoked = true; return { ok: true, stdout: "" }; },
      panel,
      identity: "local/flash",
    };
    const v = await runHarnessReview(deps, opts);

    expect(v.blocked).toBe(true);
    expect(invoked).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-harness-review.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/reviewers/harness-review.ts
import type { IPanel } from "./registry";
import { reviewerInvoke, type IInvokeDeps } from "./invoke";
import { aggregate, type IVerdict } from "./aggregate";
import { RUBRIC_VERSION, type IReviewRequest, type IValidateSummary } from "./schema";

export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_MAX_CHARS = 120000;
const GENERIC_INTENTS = new Set(["wip", "fix", "wip fix", "update", "changes", ""]);

export interface IGitRunner {
  (args: string[]): Promise<{ stdout: string; code: number }>;
}

export interface IValidateRunner {
  (): Promise<IValidateSummary>;
}

export interface IGatherDeps {
  git: IGitRunner;
  validate: IValidateRunner;
}

export interface IGatherOptions {
  base?: string;
  intent?: string;
  maxFiles: number;
  maxChars: number;
}

export type GatherResult =
  | { kind: "request"; request: IReviewRequest }
  | { kind: "block"; reason: string };

async function resolveBase(git: IGitRunner, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const res = await git(["merge-base", "main", "HEAD"]);
  const base = res.stdout.trim();

  return base.length > 0 ? base : "HEAD~1";
}

async function resolveIntent(git: IGitRunner, explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const subject = (await git(["log", "-1", "--format=%s"])).stdout.trim();

  return GENERIC_INTENTS.has(subject.toLowerCase()) ? null : subject;
}

async function changedFiles(git: IGitRunner, base: string): Promise<string[]> {
  const res = await git(["diff", "--name-only", `${base}...HEAD`]);

  return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function gatherChange(deps: IGatherDeps, opts: IGatherOptions): Promise<GatherResult> {
  const validateSummary = await deps.validate();

  if (!validateSummary.passed) {
    return {
      kind: "block",
      reason: `validate failed (${String(validateSummary.failCount)} errors) — fix the gate before review:\n${validateSummary.firstErrors.join("\n")}`,
    };
  }

  const base = await resolveBase(deps.git, opts.base);
  const intent = await resolveIntent(deps.git, opts.intent);

  if (intent === null) {
    return { kind: "block", reason: "intent is empty or generic — pass --intent \"what this change does and why\"" };
  }

  const files = await changedFiles(deps.git, base);

  if (files.length > opts.maxFiles) {
    return { kind: "block", reason: `diff too large (${String(files.length)} files > ${String(opts.maxFiles)}) — split the PR` };
  }

  const diff = (await deps.git(["diff", `${base}...HEAD`])).stdout;

  if (diff.length > opts.maxChars) {
    return { kind: "block", reason: `diff too large (${String(diff.length)} chars > ${String(opts.maxChars)}) — split the PR` };
  }

  return {
    kind: "request",
    request: { title: intent.slice(0, 80), intent, diff, validateSummary, rubricVersion: RUBRIC_VERSION },
  };
}

export interface IRunDeps extends IGatherDeps, IInvokeDeps {
  panel: IPanel;
  identity: string;
}

function blockedVerdict(reason: string, identity: string): IVerdict {
  return { blocked: true, reason, reviewers: { ok: 0, errored: 0 }, ranked: [], perReviewer: [], identity };
}

export async function runHarnessReview(deps: IRunDeps, opts: IGatherOptions): Promise<IVerdict> {
  const gathered = await gatherChange(deps, opts);

  if (gathered.kind === "block") {
    return blockedVerdict(gathered.reason, deps.identity);
  }

  const outcomes = await reviewerInvoke(deps.panel, gathered.request, {
    makeProvider: deps.makeProvider,
    runBinary: deps.runBinary,
  });

  return aggregate(outcomes, { minReviewers: deps.panel.minReviewers, identity: deps.identity });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-harness-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Ensure the barrel exports it + full validate + commit**

Confirm `packages/core/src/reviewers/index.ts` includes `export * from "./harness-review";`.

Run: `cd /Users/ag/Documents/Code/tsforge && bun run validate`
Expected: green (`N pass / 0 fail`, eslint clean).

```bash
git add packages/core/src/reviewers/harness-review.ts packages/core/src/reviewers/index.ts packages/core/tests/reviewers-harness-review.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): gather (validate-first + intent + budget) and run orchestration"
```

---

## Task 7: CLI mode — real deps, formatting, artifact, exit code

**Files:**
- Create: `packages/core/src/cli/harness-review-mode.ts`
- Modify: `packages/core/src/cli.ts` (dispatch the subcommand near cli.ts:755, alongside `scaffold`)
- Test: `packages/core/tests/reviewers-format.test.ts`

**Interfaces:**
- Consumes: `runHarnessReview`, `IVerdict`, `resolvePanel`, `resolveActiveModel`, `loadModelsConfig`, `OpenAICompatibleProvider`, `entryConfig`-equivalent, `Bun.spawn`.
- Produces:
  - `function formatVerdict(v: IVerdict): string`
  - `function harnessReviewMode(argv: string[]): Promise<number>` (returns exit code: `0` pass, `1` blocked, `2` usage/config error)

**This task wires real I/O; unit-test only the pure `formatVerdict`. The live smoke (Task 10 verification) exercises the real deps.**

- [ ] **Step 1: Write the failing test (pure formatter)**

```ts
// packages/core/tests/reviewers-format.test.ts
import { test, expect, describe } from "bun:test";
import { formatVerdict } from "../src/cli/harness-review-mode";
import type { IVerdict } from "../src/reviewers/aggregate";

const blocked: IVerdict = {
  blocked: true,
  reason: "a reviewer rejected the change",
  reviewers: { ok: 2, errored: 1 },
  ranked: [{ severity: "major", findingCode: "as-cast", file: "a.ts", issue: "cast", agreement: 2 }],
  perReviewer: [],
  identity: "local/flash",
};

describe("formatVerdict", () => {
  test("shows BLOCK, the reason, reviewer counts, and ranked findings", () => {
    const out = formatVerdict(blocked);

    expect(out).toMatch(/BLOCK/u);
    expect(out).toContain("a reviewer rejected the change");
    expect(out).toContain("ok: 2");
    expect(out).toContain("errored: 1");
    expect(out).toContain("as-cast");
  });

  test("a passing verdict shows PASS", () => {
    const out = formatVerdict({ ...blocked, blocked: false, reason: "all reviewers approved", ranked: [] });

    expect(out).toMatch(/PASS/u);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/cli/harness-review-mode.ts
import { OpenAICompatibleProvider, type IProvider } from "../inference";
import { loadModelsConfig, resolveActiveModel, resolveApiKey, type IModelEntry, type BinaryInputMode } from "../models-config";
import { resolvePanel } from "../reviewers/registry";
import { runHarnessReview, DEFAULT_MAX_FILES, DEFAULT_MAX_CHARS } from "../reviewers/harness-review";
import type { IVerdict } from "../reviewers/aggregate";

interface IArgs {
  base?: string;
  intent?: string;
  quick: boolean;
  ci: boolean;
  installHook: boolean;
}

function parse(argv: string[]): IArgs {
  const out: IArgs = { quick: false, ci: false, installHook: false };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === "--quick") {
      out.quick = true;
    } else if (a === "--ci") {
      out.ci = true;
    } else if (a === "--install-hook") {
      out.installHook = true;
    } else if (a === "--intent") {
      i += 1;
      out.intent = argv[i];
    } else if (a === "--base") {
      i += 1;
      out.base = argv[i];
    }
  }

  return out;
}

function providerConfig(entry: IModelEntry): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    ...(entry.extraHeaders === undefined ? {} : { extraHeaders: entry.extraHeaders }),
    ...(entry.extraBody === undefined ? {} : { extraBody: entry.extraBody }),
  };
}

function makeProvider(entry: IModelEntry): IProvider {
  return new OpenAICompatibleProvider(providerConfig(entry));
}

async function runBinary(
  r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
  stdin: string
): Promise<{ ok: boolean; stdout: string }> {
  const cmd = r.input === "arg" ? [...r.argv, stdin] : [...r.argv];
  const proc = Bun.spawn(cmd, {
    stdin: r.input === "stdin" ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), r.timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;

    return { ok: code === 0, stdout };
  } finally {
    clearTimeout(timer);
  }
}

async function gitRunner(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;

  return { stdout, code };
}

async function validateRunner(): Promise<{ passed: boolean; failCount: number; firstErrors: string[] }> {
  const proc = Bun.spawn(["bun", "run", "validate"], { stdout: "pipe", stderr: "pipe" });
  const text = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;
  const firstErrors = text.split("\n").filter((l) => /error/iu.test(l)).slice(0, 20);

  return { passed: code === 0, failCount: firstErrors.length, firstErrors };
}

export function formatVerdict(v: IVerdict): string {
  const head = v.blocked ? "BLOCK" : "PASS";
  const lines = [
    `harness-review: ${head} — ${v.reason}`,
    `reviewers ok: ${String(v.reviewers.ok)}  errored: ${String(v.reviewers.errored)}  (builder: ${v.identity})`,
  ];

  for (const f of v.ranked) {
    lines.push(`  [${f.severity}/${f.findingCode}] ${f.file ?? "?"} — ${f.issue} (agreement ${String(f.agreement)})`);
  }

  return lines.join("\n");
}

export async function harnessReviewMode(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (args.installHook) {
    process.stdout.write("Run: git config core.hooksPath .githooks (see .githooks/pre-push)\n");

    return 0;
  }

  const cfg = await loadModelsConfig();
  const active = await resolveActiveModel();
  const panel = resolvePanel(cfg, active);

  for (const s of panel.skipped) {
    process.stdout.write(`skipped reviewer ${s.id}: ${s.reason}\n`);
  }

  const effective = args.quick ? { ...panel, reviewers: panel.reviewers.slice(0, 1) } : panel;

  const verdict = await runHarnessReview(
    {
      git: gitRunner,
      validate: validateRunner,
      makeProvider,
      runBinary,
      panel: effective,
      identity: `${active.name}/${active.entry.model}`,
    },
    {
      base: args.base,
      intent: args.intent,
      maxFiles: DEFAULT_MAX_FILES,
      maxChars: DEFAULT_MAX_CHARS,
    }
  );

  process.stdout.write(`${formatVerdict(verdict)}\n`);

  return verdict.blocked ? 1 : 0;
}
```

Wire it in `cli.ts` — after the `scaffold` block at cli.ts:755:

```ts
  if (raw[0] === "harness-review") {
    const { harnessReviewMode } = await import("./cli/harness-review-mode");

    return harnessReviewMode(raw.slice(1));
  }
```

- [ ] **Step 4: Run the formatter test + full validate**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-format.test.ts && bun run validate`
Expected: PASS + green validate.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/harness-review-mode.ts packages/core/src/cli.ts packages/core/tests/reviewers-format.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): tsforge harness-review CLI (real git/validate/provider/binary deps + exit code)"
```

---

## Task 8: Audit artifact + verdict cache

**Files:**
- Modify: `packages/core/src/reviewers/harness-review.ts` (add artifact + cache helpers, pure/injectable)
- Modify: `packages/core/src/cli/harness-review-mode.ts` (write artifact under `.tsforge/harness-review/`, wire cache key)
- Test: `packages/core/tests/reviewers-artifact.test.ts`

**Interfaces:**
- Produces:
  - `function verdictCacheKey(input: { treeHash: string; panelHash: string; rubricVersion: string }): string`
  - `function artifactBody(v: IVerdict, meta: { treeHash: string; panelHash: string; when: string }): string` (deterministic JSON string; `when` is passed in — never `Date.now()` inside)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/reviewers-artifact.test.ts
import { test, expect, describe } from "bun:test";
import { verdictCacheKey, artifactBody } from "../src/reviewers/harness-review";
import type { IVerdict } from "../src/reviewers/aggregate";

const v: IVerdict = {
  blocked: false,
  reason: "all reviewers approved",
  reviewers: { ok: 2, errored: 0 },
  ranked: [],
  perReviewer: [],
  identity: "local/flash",
};

describe("artifact + cache", () => {
  test("cache key is stable for the same inputs and changes with the tree hash", () => {
    const a = verdictCacheKey({ treeHash: "t1", panelHash: "p1", rubricVersion: "1" });
    const b = verdictCacheKey({ treeHash: "t1", panelHash: "p1", rubricVersion: "1" });
    const c = verdictCacheKey({ treeHash: "t2", panelHash: "p1", rubricVersion: "1" });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("artifact body is valid JSON carrying verdict + identity + tree hash", () => {
    const body = artifactBody(v, { treeHash: "t1", panelHash: "p1", when: "2026-07-15T00:00:00Z" });
    const parsed = JSON.parse(body);

    expect(parsed.verdict.identity).toBe("local/flash");
    expect(parsed.treeHash).toBe("t1");
    expect(parsed.when).toBe("2026-07-15T00:00:00Z");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-artifact.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Add the helpers to `harness-review.ts`**

```ts
import { createHash } from "node:crypto";

export function verdictCacheKey(input: { treeHash: string; panelHash: string; rubricVersion: string }): string {
  return createHash("sha256")
    .update(`${input.treeHash} ${input.panelHash} ${input.rubricVersion}`)
    .digest("hex");
}

export function artifactBody(v: IVerdict, meta: { treeHash: string; panelHash: string; when: string }): string {
  return `${JSON.stringify({ when: meta.when, treeHash: meta.treeHash, panelHash: meta.panelHash, verdict: v }, null, 2)}\n`;
}
```

(Import `IVerdict` is already available in the file.)

In `harness-review-mode.ts`, after computing the verdict: compute `treeHash` = `(await gitRunner(["write-tree"])).stdout.trim()`, `panelHash` = sha256 of `JSON.stringify(cfg.reviewPanel ?? {})`, then write `.tsforge/harness-review/<treeHash>.json` with `artifactBody(verdict, { treeHash, panelHash, when: new Date().toISOString() })` via `node:fs/promises` `mkdir`+`writeFile`. Before invoking the panel, if a cached artifact for `verdictCacheKey` exists AND `!args.ci`, reuse its verdict (skip the panel). CI (`--ci`) never reads the cache.

- [ ] **Step 4: Run the test + full validate**

Run: `cd /Users/ag/Documents/Code/tsforge && bun test packages/core/tests/reviewers-artifact.test.ts && bun run validate`
Expected: PASS + green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reviewers/harness-review.ts packages/core/src/cli/harness-review-mode.ts packages/core/tests/reviewers-artifact.test.ts
git -c commit.gpgsign=false commit -m "feat(reviewers): audit artifact + verdict cache (CI bypasses cache)"
```

---

## Task 9: Pre-push hook (path-filtered, convenience layer)

**Files:**
- Create: `.githooks/pre-push`
- Test: manual (documented commands + a dry-run)

**Interfaces:** none (shell). The hook runs `harness-review` only when `packages/core/**` changed vs `@{push}`/`main`; docs-only pushes skip.

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
# Convenience gate: run the independent review panel before a push that touches
# harness code. CI is the authority; this only catches problems earlier. Bypass
# with --no-verify (CI still enforces).
set -euo pipefail

base="$(git merge-base main HEAD 2>/dev/null || echo HEAD~1)"
if git diff --name-only "$base"...HEAD | grep -q '^packages/core/'; then
  echo "harness-review: harness code changed — running the review panel..."
  bun run packages/core/src/cli.ts harness-review || {
    echo "harness-review BLOCKED the push. Fix findings or --no-verify (CI still enforces)." >&2
    exit 1
  }
else
  echo "harness-review: no packages/core changes — skipping panel."
fi
```

- [ ] **Step 2: Make it executable + document install**

Run:
```bash
cd /Users/ag/Documents/Code/tsforge
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
```
Expected: no output (success).

- [ ] **Step 3: Dry-run the path filter (docs-only skip)**

Run: `cd /Users/ag/Documents/Code/tsforge && git diff --name-only "$(git merge-base main HEAD)"...HEAD | grep -q '^packages/core/' && echo "would run panel" || echo "would skip"`
Expected: prints `would run panel` (this branch changed core) — confirms the filter logic.

- [ ] **Step 4: Commit**

```bash
git add .githooks/pre-push
git -c commit.gpgsign=false commit -m "feat(reviewers): path-filtered pre-push hook (convenience; CI is authority)"
```

---

## Task 10: CI authority job + live smoke

**Files:**
- Create: `.github/workflows/harness-review.yml`
- Test: live smoke (documented) + the workflow is the enforcement of record.

**Interfaces:** none. CI runs `tsforge harness-review --ci` on PRs to the harness repo with the panel secrets.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/harness-review.yml
name: harness-review
on:
  pull_request:
    paths:
      - "packages/core/**"
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Independent review panel
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        run: bun run packages/core/src/cli.ts harness-review --ci --base "origin/${{ github.base_ref }}"
```

- [ ] **Step 2: Full validate (whole feature green)**

Run: `cd /Users/ag/Documents/Code/tsforge && bun run validate`
Expected: green (`N pass / 0 fail`, eslint clean).

- [ ] **Step 3: Live smoke — real panel on this branch's own diff**

Precondition: `~/.tsforge/models.json` has a `reviewPanel` with ≥2 independent reviewers (e.g. an OpenRouter model + the `grok` binary). Then:

Run: `cd /Users/ag/Documents/Code/tsforge && bun run packages/core/src/cli.ts harness-review --intent "add the independent harness-review gate"`
Expected: prints per-reviewer verdicts, a ranked-findings list, and `PASS`/`BLOCK`. Confirm reviews parse (no "unparseable" errored reviewers from a well-formed model) and the verdict is sane. If a reviewer errors on parse, tighten `REVIEW_SYSTEM_PROMPT` and re-run — do NOT loosen the schema guard.

- [ ] **Step 4: Seeded false-PASS check (the real success metric)**

Create a throwaway commit that introduces a defect the rubric names (e.g. add `const x = y as string;` in a scratch file, no test), run `harness-review`, confirm it **BLOCKS** with an `as-cast`/`missing-test` finding, then discard the commit:

Run:
```bash
cd /Users/ag/Documents/Code/tsforge
git stash -u 2>/dev/null || true
# (implementer: add a deliberate `as` cast to a scratch file, commit, run review, expect BLOCK, then reset)
```
Expected: BLOCK. Record the outcome in the final review notes. A seeded bad diff that PASSES is a Task-4/Task-1 defect — fix before merge.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/harness-review.yml
git -c commit.gpgsign=false commit -m "ci(reviewers): PR harness-review job (the independence authority)"
```

---

## Self-Review

**1. Spec coverage:**
- Authority model (CI authority / pre-push convenience / deterministic aggregator / builder-reacts) → Tasks 9, 10, 4, 7. ✓
- Independence invariant (normalized compare + denylist + floor + identity in artifact) → Task 3 + Task 8 (identity in artifact). ✓
- `reviewPanel` config (not overloaded capabilities; model refs entry; binary argv/input/timeout/parse) → Task 2. ✓
- Frozen `IReviewRequest`/`IReview`/`IVerdict` + `FindingCode` + rubric → Task 1. ✓
- `reviewerInvoke` parallel, fault-tolerant, structured/extractJson, errored≠approve → Task 5. ✓
- `aggregate` rules (reject / 2×serious-locus / single critical-security / majority-major / <minReviewers) + locus normalization → Task 4. ✓
- Validate-first, diff budget, intent priority → Task 6. ✓
- CLI (`--ci/--quick/--intent/--base/--install-hook`), artifact, cache, path filter → Tasks 7, 8, 9. ✓
- Verification incl. false-PASS on seeded bad diffs → Task 10 Step 4. ✓
- Relationship to `loop/review/*` → documentation only (spec section); no code, no task needed. ✓ (Noted: no separate task — it's a doc statement, not a build artifact.)

**2. Placeholder scan:** Task 8 Step 3 and Task 10 Step 4 describe I/O wiring in prose rather than a full code block (Bun `fs` writes / a throwaway commit). These are genuinely environmental (filesystem + interactive git) and each names exact paths, functions, and expected outcomes — acceptable, but the implementer must write the real `mkdir`/`writeFile` calls, not a stub.

**3. Type consistency:** `IReview`/`IFinding`/`FindingCode`/`IReviewRequest`/`IValidateSummary` (Task 1) are consumed unchanged by Tasks 4–7. `ReviewOutcome` defined in Task 4, imported by Task 5. `IPanel`/`ResolvedReviewer` defined in Task 3, consumed by Tasks 5–7. `IInvokeDeps` (Task 5) extended by `IRunDeps` (Task 6). `IVerdict` (Task 4) formatted in Task 7, serialized in Task 8. Names checked consistent across tasks.

**Out-of-scope observation (do NOT fix here):** `parseCapabilities` in `models-config.ts:206` rejects the `planner` capability although `CAPABILITY_NAMES` includes it and `resolveCapabilityModel` handles it — a latent pre-existing bug. Left untouched; flag separately.
