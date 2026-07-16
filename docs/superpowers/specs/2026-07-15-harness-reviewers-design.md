# harness_reviewers — independent external review gate (design)

## Context / why

tsforge's quality has depended on the *building* agent (me) also *judging* its own work — and that has failed repeatedly: a change is declared "done", the real defect surfaces later. The fix is structural: an **independent panel of external reviewers** whose verdict the builder cannot fake. Reviewers are other models (OpenRouter / OpenAI-compatible) and binaries (e.g. `grok`) — never the builder's own model. A deterministic aggregator fuses their reviews into a **blocking** verdict; the builder reacts to findings but does not decide pass/fail.

Scope is **both** "review a harness change" and "review a build run", built on **one shared reviewer/aggregator core**. This spec covers the shared core + **Phase 1: gating my changes to the harness itself**. Phase 2 (review a build run) reuses the core and gets its own spec. `ReviewRequest` and `IVerdict` are **frozen** by this spec so Phase 2 cannot fork the core.

## The authority model (this is the whole point)

The blocking verdict is the panel's, computed deterministically, runnable identically by a human or CI. Independence is layered — no single layer is trusted alone:

1. **CI is the authority.** A CI job runs `tsforge harness-review --ci` on every PR to the harness repo, with the panel's secrets, no cache, no install step. This is the enforcement that a builder cannot skip. Phase 1 is **not done** until this job exists and blocks merge.
2. **Local pre-push is convenience**, not a guarantee — it can be `--no-verify`'d or have its hook uninstalled. It exists to catch problems before CI, not to be the gate of record.
3. **The aggregator is deterministic code** — no second model to collude with, unit-testable.
4. **The builder reacts, never decides** — it reads findings, fixes, re-runs; it cannot emit a PASS.

### Independence invariant (stronger than "different model string")
A reviewer is rejected/skipped if it is not independent of the active builder:
- Compare **normalized** `(baseUrl host, model id)` — not the raw config string — against the active build model, so the same weights under a different alias/slug is still caught.
- **Denylist** the active model entry's name AND its resolved model id.
- `minReviewers` is **floored at 2 in code** for `harness-review` — a user cannot set it to 1 and self-approve with one friendly model.
- The active builder model/entry at review time is **recorded in the audit artifact** (below) so independence can be checked post-hoc.

## Shared reviewer core

### Config — a dedicated `reviewPanel` field (NOT overloaded `capabilities`)
`capabilities` today maps one role → one **named `models{}` entry** (`Partial<Record<"vision"|"imageGen"|"expert"|"planner", string>>`). A review panel is a *heterogeneous list* of runners (models + binaries), so it gets its own sibling field rather than fake `models{}` entries with bogus baseUrls:

```jsonc
{
  "active": "qwen-local",
  "models": { "opus": { ... }, "sonnet": { ... } },
  "capabilities": { "expert": "opus" },
  "reviewPanel": {
    "minReviewers": 2,
    "reviewers": [
      { "kind": "model",  "id": "opus",   "entry": "opus" },
      { "kind": "model",  "id": "sonnet", "entry": "sonnet" },
      { "kind": "binary", "id": "grok",
        "argv": ["grok", "--always-approve", "-p"],
        "input": "arg", "timeoutMs": 180000, "parse": "json-fence" }
    ]
  }
}
```
- **Model reviewers** reference an existing `models{}` entry by `entry` key (reuse its baseUrl / env-ref apiKey / headers) — they do **not** re-declare connection fields.
- **Binary reviewers** specify `argv` (array, no shell), `input` (`"stdin" | "arg" | "tempfile"`), `timeoutMs`, and `parse` (`"json-fence"` = last ```json block | `"raw"` = whole stdout). `cwd` = repo root, env allowlist only, no `shell: true`.
- Reuses the existing `models-config` capability-routing + `OpenAICompatibleProvider` for model reviewers.

### `ReviewRequest` (frozen — Phase 2 reuses)
`{ title, intent, diff, validateSummary, contextFiles?, rubricVersion }` — target-agnostic.
- `diff` is **budgeted** (see Diff budget). `validateSummary = { passed, failCount, firstErrors: string[] }` — never a bare boolean; reviewers need the actual first K errors.
- `contextFiles` are optional touched-but-secondary files (tests/docs) the reviewer may read for context.

### `reviewerInvoke(request)` — parallel, per-reviewer fault-tolerant
Runs every configured reviewer **concurrently** (concurrency cap 5; cancel stragglers once enough have returned):
- **model reviewers:** one `complete()` call. Use structured-output schema when the provider advertises guided decoding; otherwise prompt + the existing `extractJson` + validate against the schema guard. A parse/validation failure → that reviewer is **`errored`**, never an empty approve. System prompt is skeptical / reject-by-default and carries the static rubric (below).
- **binary reviewers:** subprocess per `argv`/`input`; parse per `parse`; timeout → `errored`; not-on-PATH → `errored`.
- A reviewer that errors/times out is **skipped and recorded as `errored`** — never silently counted as approval.

### Schema (frozen)
- `IFinding = { severity: "critical"|"major"|"minor", findingCode: FindingCode, file?, line?, issue, fix? }`.
- `FindingCode` is a **small closed enum + `"other"`**, so cross-model agreement keys on a stable code, not fuzzy prose: e.g. `missing-test`, `as-cast`, `non-null-assert`, `gate-relaxed`, `complexity`, `scope-bypass`, `security`, `supply-chain`, `dead-code`, `wrong-idiom`, `other`.
- `IReview = { reviewerId, verdict: "approve"|"request-changes"|"reject", findings: IFinding[], summary }`.

### The rubric (static, versioned in-repo)
A single versioned rubric string (`rubricVersion`) injects the house rules into **every** reviewer system prompt, so external models share one checklist without coupling to the in-process review scheduler: no `as`/`!`/`any`, cc ≤ 20, tests mirror changed code, never relax the gate, tool/reviewer independence, no silent truncation. Bumping the rubric bumps `rubricVersion` (recorded in the artifact).

### `aggregate(reviews): IVerdict` — deterministic, pure, unit-tested
`blocked = true` if **any** of:
- any reviewer returns `reject`, OR
- **≥2** reviewers raise a `critical|major` finding at the **same locus**, OR
- **any single** reviewer raises a `critical` finding with a security-class `findingCode` (`security` / `supply-chain`) — a serious trust-boundary hit doesn't wait for a second vote, OR
- a **majority** of successful reviewers return `request-changes|reject` with at least one `major`, even without locus agreement (three models each raising a different real major shouldn't pass), OR
- fewer than `minReviewers` (≥2) reviewers returned successfully.

**Locus** = `(normalized-file, findingCode)` when `findingCode !== "other"`, else `(normalized-file, normalized-issue)`. File normalization: repo-relative, strip `a/`/`b/`, normalize slashes. Issue normalization: lowercase, collapse whitespace, strip leading articles, cap length. **Line is never required** for "same locus" (models disagree on lines constantly).

Findings are **deduped** by locus; each carries `agreement` = how many reviewers raised it; ranked by `severity × agreement`. `IVerdict = { blocked, reason, reviewers: {ok, errored}, ranked: IFinding[], perReviewer: IReview[], identity }` (frozen). `identity` = active builder model/entry at review time.

## Phase 1 — gate on harness changes

### `tsforge harness-review` (new CLI, run in the tsforge repo)
1. **Gather.** Resolve the change: `git diff <base>...HEAD` + working tree (`--base` overrides base; default = merge-base with `main`). Intent priority: `--intent` > plan-file path > `git log -1` > `git log <base>..HEAD --oneline`; intent is **required** (error) when the commit subject is empty or generic (`wip`, `fix`).
2. **Validate first.** Run (or read) `bun run validate`. **If validate is red → BLOCK immediately** with the validate findings only; do NOT spend the panel. The gate owns mechanical TS; the panel owns judgment the gate can't see. The panel runs only when validate is green.
3. **Diff budget.** Enforce a hard cap (max files / max chars). Prefer full patches for the top-churn changed paths + `git diff --stat` for the rest. **Over budget → BLOCK** with `reason: "diff too large — split the PR"` (no silent truncation; no multi-chunk review in Phase 1).
4. **Review.** Build the `ReviewRequest`, call `reviewerInvoke`, then `aggregate`.
5. **Report.** Print ranked findings + per-reviewer verdicts; write an **audit artifact** to `.tsforge/harness-review/<gitTreeHash>.json` (verdict + per-reviewer + identity + rubricVersion); **exit non-zero when `blocked`**.

### Operability (so the hook doesn't get `--no-verify`'d)
- **Path filter:** pre-push runs the panel only when harness paths (`packages/core/**`) changed; docs-only pushes skip it.
- **Verdict cache:** keyed by `(git write-tree hash, panel-config hash, rubricVersion)`; an unchanged tree reuses the verdict instead of re-calling the panel.
- **Modes:** `--ci` (no install, no cache, strict — CI's mode); `--quick` (1 external reviewer + validate, for fast local iteration). Full panel green is what "done" requires; CI enforces full.

### Enforcement
- **CI job (authority):** `tsforge harness-review --ci` on PRs to the harness repo, blocks merge. Spec-required for Phase 1.
- **Local git pre-push hook (convenience):** `.githooks/pre-push` + `core.hooksPath`, installable via `tsforge harness-review --install-hook`. Documented as bypassable; CI is the backstop.
- **Reaction loop:** I read ranked findings, fix the blocking ones, re-run; repeat until PASS. I never override a BLOCK.

## Relationship to the existing in-repo review
tsforge already has a multi-lens review path (`loop/review/*`, scheduler, verify pass). They are **different systems and both stay**:

| System | Role |
| --- | --- |
| `loop/review/*` | Same-process, same-provider-capable review *during* agent work (advisory, in-loop). |
| `reviewers/*` panel | External, blocking, independence-enforced gate on a finished change. |

Phase 1 does **not** reimplement the lenses inside the panel. It only borrows the lens rubric text as static criteria in the reviewer system prompt (via the rubric). The `.claude/skills/harness/harness-review` skill can shell out to this CLI.

## Components / files (tsforge)
- `packages/core/src/reviewers/registry.ts` — load + validate `reviewPanel`; resolve model reviewers against `models{}`; independence check (normalized compare + denylist); floor `minReviewers`.
- `packages/core/src/reviewers/invoke.ts` — parallel model+binary invocation, concurrency cap, timeouts, per-reviewer error tolerance, structured-vs-`extractJson` output handling.
- `packages/core/src/reviewers/schema.ts` — `IReview`/`IFinding`, `FindingCode` enum, the reviewer JSON schema, the skeptical system prompt, the versioned rubric.
- `packages/core/src/reviewers/aggregate.ts` — deterministic fuse/dedup/rank/verdict (pure, unit-tested).
- `packages/core/src/reviewers/harness-review.ts` — split `gather` / `format` / `main`; diff budget, validate-first short-circuit, cache, artifact write, exit code.
- CLI wiring: `tsforge harness-review` (+ `--ci`, `--quick`, `--install-hook`, `--intent`, `--base`).
- `.githooks/pre-push` (path-filtered) invoking the command.
- CI: a workflow job running `tsforge harness-review --ci`.
- Reuse: `models-config` (capability routing), `OpenAICompatibleProvider`, `extractJson`, the `grok -p` headless pattern.

## Data flow
`harness-review` → gather(diff, intent) → validate (red → BLOCK) → diff-budget (over → BLOCK) → cache hit? → `reviewerInvoke` (N parallel: models via schema/`extractJson`; binaries via subprocess) → `IReview[]` → `aggregate` (deterministic) → `IVerdict` → print + artifact + exit code → (if blocked) I fix → re-run.

## Error handling
- Reviewer failure (network/timeout/parse) → `errored`, excluded; successful < `minReviewers` → BLOCK ("insufficient reviewers").
- No reviewers configured → command errors loudly (never silently passes).
- Binary not on PATH → `errored` reviewer.
- Validate red → BLOCK with validate findings (panel not spent).
- Diff over budget → BLOCK ("split the PR").

## Verification
- Unit (pure) `aggregate`, table-driven: reject→block; 2×major-same-locus→block; single critical security→block; majority-major-no-locus→block; dedup + agreement ranking; `<minReviewers`→block; all-approve→pass; locus keys on `findingCode` then normalized issue.
- Unit `reviewerInvoke`: fake model provider + fake binary (echoes JSON); a reviewer that throws → `errored`, others still returned; parse failure → `errored` not approve.
- Unit `registry`: same-weights-different-alias caught; active-entry denylisted; `minReviewers` floored at 2.
- Integration: deliberately-bad diff → BLOCK with expected `findingCode`; clean diff → PASS; validate-red diff → BLOCK without spending panel; over-budget diff → BLOCK.
- **False-PASS rate (success metric):** a corpus of seeded bad diffs (introduced `as`, removed test, relaxed a gate severity, scope bypass) must be BLOCKED. Report the false-PASS rate, not "smoke looks sane."
- Live smoke: real panel (`grok` + one OpenRouter model) on an actual tsforge diff; confirm reviews parse and the verdict is sane.
- House rules throughout: no `as`, cc ≤ 20, `bun run validate` green.

## Not doing (Phase 1)
- Build-run review (Phase 2 — reuses the frozen core; separate spec).
- During-run / streaming reviews that steer mid-build (later).
- Auto-applying reviewer-suggested fixes (I apply, then re-review).
- An aggregator model (deterministic only).
- Multi-chunk review of an over-budget diff (prefer split-PR; deferred).
- A "require ≥1 strong-tier reviewer" policy knob (YAGNI — the user configures the panel).

## Rejected from the review (with reason)
- **Multi-chunk aggregation for huge diffs** — deferred; the reviewer itself recommends split-PR for Phase 1, and chunk-stitching adds real complexity for a case a diff budget already forces the human to avoid.
- **A "strong-tier" reviewer requirement** — YAGNI for Phase 1; encoding tier labels in config to enforce panel strength is policy the user already exercises by choosing the panel. Revisit only if a weak-clone panel is observed passing bad diffs.
