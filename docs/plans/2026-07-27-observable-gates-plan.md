# Observable-Gates Plan — killing the "trust the proxy, not the outcome" false-green class

Source: 2-round consultation with the 4-model panel (deepseek-pro, glm, grok, codex),
seeded with the Reddit/DeepSeek thesis and validated against the tsforge harness. All
four converged; disagreements adjudicated below. Two of my own code-verifications anchor it.

## Diagnosis (unanimous)

The dominant class of **runtime/product** false-greens (the jump from "well-formed code"
to "shipped behavior") is: the harness scores that an action **ran** (exit 0 / substring
present / tests green / judge said pass) instead of asserting the final **observable
state**. It's structural, not a few incidents — the same shape recurs at db:push (#200,
#204), reachability (#202), resume baseline (#198), hollow-UI/wiring, and the review panel
(META: the panel passed a fix by inheriting its framing; only a live build falsified it).
Corollary the panel corrected me on: **most per-cycle reds are honest** (lint/type/knip) —
the lie is specifically at the code→behavior boundary. So the fix is targeted, not a rewrite.

## Verified facts (I checked the code)

1. **`noE2eAcceptance` is real gate-relaxation.** In `build.ts runFinalAcceptance`, a failed
   FULL gate (validate/build/size/root-drift) only flips to `stuck` when e2e is *enabled*;
   with the flag set it emits a "stuck" event but `return result` keeps the passed status.
   The `boringstack-final-acceptance.test.ts` "FIX 5" case codifies this as intended.
2. **`settleGate` does NOT green-cache** — it re-runs `evaluateGate` every cycle. The only
   real caches are the panel verdict cache (`harness-review-mode.ts`) and the differential
   baseline. (Kills a round-1 red herring.)
3. **Polish-recheck failure rolls back to the pre-polish green** (a genuine green), so it's
   defensible; residual risk is only an incomplete rollback (files outside snapshot / DB).

## Plan (ordered; per-cycle cheap, expensive stuff to CI/live-qualification)

### P0a — Make the full gate terminal regardless of `noE2eAcceptance`  (cheap, ~0 cost)
- Seam: `build.ts runFinalAcceptance` (the `!finalPassed && !e2eAcceptanceDisabled` branch,
  ~line 873); invert `boringstack-final-acceptance.test.ts` "FIX 5". The flag skips only the
  browser/chain e2e — a failed validate/build/size/root-drift is ALWAYS terminal.
- Observable: full gate red ⇒ status `stuck` and headless exits nonzero, flag or not.
- Proof: unit test both flag states against a failing full gate → both `stuck`; live repro:
  set the flag, inject deterministic root-drift/size failure, assert exit 1 (was exit 0/done).

### P0b — DB boundary oracle after every successful `db:push`  (per-cycle, ~1–2s/entity)
- Seam: new `boringstack/db-oracle.ts`, invoked right after `dbPushForce` in
  `gate-stages.ts` (thread the entity spec already derived in `build.ts`); query the same
  `DATABASE_URL`.
- Expected columns are **harness-derived from the PLAN, never the model's schema file**:
  table = `toCamelCase(entity.id)` in schema `app`; required set =
  `{id, user_id, created_at, updated_at}` ∪ plan fields ∪ `{relEntity}_id` for each non-User
  belongs-to (reuse the relationship derivation in `acceptance-spec.ts`; `belongs to User` →
  existing `user_id`). **SUBSET, not exact** (scaffold/model may add extra columns — don't
  fail on extras). Assert column **presence** (SQL type families are too coarse for the
  current plan types → at most a soft check). Match names **tolerant of camel/snake**
  (verified: the live DB uses `user_id`/`created_at`; domain cols use the field name as
  written) — normalize (strip `_`, lowercase) both sides. Stub `name` required only if the
  plan declares `name`.
- Two-phase: the pre-model scaffold push can't have domain fields yet → assert only the
  fixed infra columns there; apply the full contract after model edits.
- Proof: exit-0 push whose DB lacks `title` for `Bookmark{title,url}` ⇒ `db-schema-mismatch`
  BEFORE validate runs; extra columns pass; replay valbuild27/#204 + #200 → red same cycle.

### P1 — Reachability = real HTTP + DB-derived sentinel  (per-cycle, one fetch + one SELECT)
- Seam: replace the source-substring path in `reachability.ts` with an authenticated request
  after the command gate (keep static as a cheap prefilter if useful). `fetch`, NOT Playwright.
- Observable: seed a unique sentinel row via the real create path, `GET` the collection/detail,
  assert the response body carries that sentinel (tri-point: plan → seed → DB row → HTTP body).
  A 200 with a template/stub body fails.
- Proof: route registered but handler returns `[]`/stub, or route unmounted, or API-only/DB-only
  → each red. Live: hollow-API greens that pass today.

### P2 — Sentinel identity in the per-slice e2e (finish the partial)  (CI/final acceptance)
- Seam: `e2e-generator.ts` / `e2e-runner.ts`. The one harness identity must appear in the UI
  row AND an authenticated API GET AND a direct DB SELECT (extend the existing unique-value row
  check). Keep create/edit/delete→reload orderings. Add persisted-FK verification to the chain.
- Proof: valbuild19 hollow Contact/Deal, build49 dead hooks → red; a usable Company → green.

### P2 — Adversarial orderings that are actually ours  (CI/live-qualification only)
- Keep: **schema-evolve** (stub `name` → domain cols; the #204 trigger) and **reload/restart-persist**
  (sentinel survives). **Drop generic concurrent-rewrite** — single-user CRUD has no conflict semantics.

### P3 — Harness-honesty "disable-must-fail" suite  (CI only, NOT per-cycle)
- Seam: a mutant runner under `packages/core/scripts/` wired into `core-ci.yml`.
- Observable: deliberately break each control (drop a column, unmount a route, strip a testid,
  mock an exit-0 no-op db:push, disable the P0a terminal branch) → the suite MUST go red.
- Require this artifact only for PRs that touch behavioral-control seams (not every PR).
- Proof: mutants replay #204, the disabled-e2e/full-red repro, and 200-without-sentinel.

### P4 — Panel cache + framing integrity  (pre-push/CI)
- Seam: `harness-review-mode.ts`. Always run current `validate` before trusting a cached
  verdict; key the cache by diff+base+intent+reviewer-roster+quick/full mode (agreed win).
- Framing control: adopt the cheap **fails-when-disabled artifact** for harness-behavioral PRs
  now. Treat glm's **framing-free counterfactual reviewer** (one reviewer sees only the DB
  schema diff + plan field list, never the narrative) as an EXPERIMENT — A/B it on planted
  defects before making it blocking (codex/grok caution: could be bureaucratic/proxy).

## Explicitly DROPPED (low-ROI / over-correction — unanimous)
- Generic concurrent-rewrite / race suites (not our failure mode).
- `settleGate` green-cache work (falsified — it re-runs every cycle).
- Per-cycle Playwright or full 4-model panel.
- Blanket secret/logging sink sweep — plan-gated only, if a plan ever declares logging/secrets.
- Auto-classifying Postgres error text as red/green (unwinnable, already a known tar-pit).
- Deriving oracle expected-columns from the model's migration/schema file.
- deepseek's reverse/exact-equality column check (majority: subset-presence only).
- Polish-rollback rework as a P0 (defensible; residual partly caught by P0b anyway).

## Guardrails (unanimous)
Never relax the gate; every new check is ADDITIVE and turns the gate RED (never redefines
green). Deterministic cheap oracles (SQL/HTTP) run per-cycle; browser + mutation + adversarial
run at final acceptance / CI only (per-cycle Playwright latency+flakiness trains the model to
ignore reds). Boundary asserts derive from the PLAN, not the model's own output. Flakiness is
browser/env, not SQL — fix isolation, don't retreat to mocks.

## Sequencing recommendation
P0a first (1-line-ish, restores gate integrity, ~0 cost), then P0b (the primary runtime
truth-source), each shipped as its own PR with an observable test + a live-build repro, panel-
reviewed. Then P1. P2–P4 as follow-ons. One boundary check at a time, each proven by making
the OLD behavior go red.
