# harness_reviewers — independent external review gate (design)

## Context / why

tsforge's quality has depended on the *building* agent (me) also *judging* its own work — and that has failed repeatedly: a change is declared "done", the real defect surfaces later. The fix is structural: an **independent panel of external reviewers** whose verdict the builder cannot fake. Reviewers are other models (OpenRouter / OpenAI-compatible) and binaries (e.g. `grok`) — never the builder's own model. A deterministic aggregator fuses their reviews into a **blocking** verdict; the builder reacts to findings but does not decide pass/fail.

Scope is **both** "review a harness change" and "review a build run", built on **one shared reviewer/aggregator core**. This spec covers the shared core + **Phase 1: gating my changes to the harness itself**. Phase 2 (review a build run) reuses the core and gets its own spec.

## Shared reviewer core

- **Reviewer registry** — `capabilities.reviewers` in `models.json`: an array. Each entry is either
  - a **model**: `{ kind: "model", id, baseUrl, apiKey (env ref), model, extraHeaders? }` (OpenRouter / any OpenAI-compatible), or
  - a **binary**: `{ kind: "binary", id, command }` (e.g. `grok --always-approve -p` invoked headless).
  Populated by the user (target 3–5). MUST NOT include the builder's own model — a startup check warns/skips if an entry's model matches the active build model (independence invariant). Reuses the existing `models-config` capability-routing + `OpenAICompatibleProvider`.
- **`ReviewRequest`** (what a reviewer is given): `{ title, intent, diff, validateResult, contextFiles? }` — target-agnostic.
- **`reviewerInvoke(request)`** — runs every configured reviewer **in parallel**:
  - model reviewers: one `complete()` call constrained to the **review JSON schema** (structured output), skeptical/reject-by-default system prompt.
  - binary reviewers: subprocess with the request rendered to stdin/prompt; parse the JSON block from stdout.
  - A reviewer that errors/times out is **skipped and recorded as `errored`** — never silently counted as approval.
- **`IReview`** (structured, one per reviewer): `{ reviewerId, verdict: "approve"|"request-changes"|"reject", findings: IFinding[], summary }`; `IFinding = { severity: "critical"|"major"|"minor", file?, line?, issue, fix? }`.
- **`aggregate(reviews): IVerdict`** — **deterministic** (no model): 
  - `blocked = true` if any reviewer `reject`, OR ≥2 reviewers raise a `critical|major` finding at the same locus (same file + normalized issue), OR fewer than `minReviewers` (default 2) returned successfully.
  - findings **deduped** across reviewers by `(file, normalized-issue)`; each carries `agreement` = how many reviewers raised it; ranked by `severity × agreement`.
  - `IVerdict = { blocked, reviewers: {ok, errored}, ranked: IFinding[], perReviewer: IReview[] }`.

## Phase 1 — gate on harness changes

- **`tsforge harness-review`** (new CLI command, run in the tsforge repo):
  1. Gathers the change: `git diff <merge-base>...HEAD` + working tree, the intent (last commit message / `--intent` flag / plan), and runs (or reads) `bun run validate` result.
  2. Builds a `ReviewRequest`, calls `reviewerInvoke`, then `aggregate`.
  3. Prints the ranked findings + per-reviewer verdicts; **exits non-zero when `blocked`**.
- **Enforcement:** blocking. A harness change is not "done" until `harness-review` passes. Also installed as a **git pre-push hook** (`.githooks/pre-push` + `core.hooksPath`, or a documented `tsforge harness-review --install-hook`) so unreviewed harness commits can't reach the branch. The verdict is the panel's, not mine.
- **Reaction loop:** I read the ranked findings, fix the blocking ones, re-run `harness-review`; repeat until PASS. I never override a BLOCK.

## Components / files (tsforge)
- `packages/core/src/reviewers/registry.ts` — load + validate `capabilities.reviewers`; independence check.
- `packages/core/src/reviewers/invoke.ts` — parallel model+binary invocation, per-reviewer error tolerance.
- `packages/core/src/reviewers/schema.ts` — `IReview`/`IFinding` + the reviewer JSON schema + skeptical system prompt.
- `packages/core/src/reviewers/aggregate.ts` — deterministic fuse/dedup/rank/verdict (pure, unit-tested).
- `packages/core/src/reviewers/harness-review.ts` — gather diff+intent+validate, run core, format, exit code.
- CLI wiring: `tsforge harness-review` (+ `--install-hook`, `--intent`, `--base`).
- `.githooks/pre-push` invoking the command.
- Reuse: `models-config` (capability routing), `OpenAICompatibleProvider`, the `grok -p` headless pattern.

## Data flow
`harness-review` → gather(diff, intent, validate) → `reviewerInvoke` (N parallel: models via schema-constrained complete(); binaries via subprocess) → `IReview[]` → `aggregate` (deterministic) → `IVerdict` → print + exit code → (if blocked) I fix → re-run.

## Error handling
- Reviewer failure (network/timeout/parse) → that reviewer is `errored`, excluded; if successful reviewers < `minReviewers`, verdict is BLOCK (can't certify with too few) with a clear "insufficient reviewers" reason.
- No reviewers configured → command errors loudly (won't silently pass).
- Binary not on PATH → treated as an errored reviewer.

## Verification
- Unit (pure): `aggregate` — reject→block; 2×major-same-locus→block; dedup + agreement ranking; <minReviewers→block; all-approve→pass. Fake `IReview[]` inputs.
- Unit: `reviewerInvoke` with a fake model provider + a fake binary (echoing JSON); a reviewer that throws → `errored`, others still returned.
- Integration: a deliberately-bad diff → BLOCK with the expected finding; a clean diff → PASS.
- Live smoke: real panel (`grok` + one OpenRouter model) on an actual tsforge diff; confirm structured reviews parse and the verdict is sane.
- House rules throughout: no `as`, cc ≤ 20, `bun run validate` green.

## Not doing (Phase 1)
- Build-run review (Phase 2 — reuses the core; separate spec).
- During-run / streaming reviews that steer mid-build (later).
- Auto-applying reviewer-suggested fixes (I apply, then re-review).
- An aggregator model (deterministic only).

## Independence invariant (the whole point)
Reviewers are external models/binaries the user configures; the aggregator is deterministic; the blocking verdict is the panel's. The builder reacts to findings and cannot declare pass — enforced by exit code + pre-push hook, runnable identically by the user/CI.
