# Core Harness Due-Diligence Audit — Session Handoff Plan

> Written 2026-08-02 for a fresh session (intended: Opus 5). Self-contained — read this
> top-to-bottom and you can start cold. BoringStack adapter is OUT OF SCOPE for this pass.

## Why we're doing this

Task #105 (greenfield strict-rule enforcement, shipped in **0.35.0**) took **13 rounds** of
the 4-model review panel and surfaced ~a dozen real bugs in the **core** harness — not the
BoringStack adapter: gate cache keyed wrong, gate-relaxation via config re-read, resume
mis-classification, `/clear` re-arm, silent truncation, prototype-pollution in `isProfileId`,
baseGate override-ordering, `--profile` never actually parsed, an `opinionated` profile that
LOWERED a rule below default, etc. ag's conclusion: if that many defects hid in one feature's
blast radius, the **core deserves a systematic, adversarial audit before returning to
BoringStack**. This is that audit.

## Goal

Two lenses, both exhaustive. Produce a **severity-sorted findings list**, each tied to a
concrete `file:line` + a fix sketch or a new backlog task. Land fixes as **small,
panel-gated PRs** (ag signs every merge + release — never merge to main yourself).

- **Lens A — Code audit.** Adversarially review every CORE subsystem for bugs, gate
  relaxations, edge cases, missing tests, dead code, and DRY violations — using BOTH the
  project's own 4-model `harness-review` panel AND read-only Explore subagents.
- **Lens B — Docs cross-reference.** Cross-check EVERY Astro/Starlight doc page
  (`apps/docs/src/content/docs`) against the actual core code. Flag: wrong facts, stale /
  removed features, contradictions, undocumented behavior, dead links, missing coverage.
  (This is the #97–#102 docs-sync work, but exhaustive and re-verified.)

## Starting state (2026-08-02)

- On `main`, clean, version **0.35.0** (just released; #105 merged as squash `54d49250`).
- `origin` = `https://github.com/agjs/tsforge.git` (SSH is broken here — push via origin, it's https).
- **CORRECTED 2026-08-02 (verified in code — do not relearn this):** the 4-model panel is
  **diff-based, not subsystem-based**. `bun run packages/core/src/cli.ts harness-review`
  accepts only `--base / --intent / --quick / --ci / --install-hook`
  (`packages/core/src/cli/harness-review-mode.ts:36`), and `gatherChange`
  (`packages/core/src/reviewers/harness-review.ts:95`) BLOCKS unless `validate` is green and
  there is a non-empty `base...head` diff within `DEFAULT_MAX_FILES`/`DEFAULT_MAX_CHARS`.
  ⇒ The panel **gates fix diffs**; it cannot audit a subsystem cold. `[subsystem|all]` is the
  *skill*'s vocabulary (`.claude/skills/harness/harness-review/SKILL.md`), a Claude-driven
  procedure. **Discovery = read-only `Explore` agents running the skill's procedure;
  verdict = the panel, per fix PR.**
- The pre-push panel is **not installed** in this clone — `.git/hooks/` has no non-sample
  hook. Panel runs are manual (`--install-hook` installs it).
- Verify a panel result by "reviewers ok: N (N≥2), errored: …" — a run with only errored
  reviewers is environmental, re-run; NEVER treat 0-reviewers as a pass.

## Work-list (scoped 2026-08-02)

### Subsystems to review — from `docs/harness-subsystems.md` (the review manifest / contract)
Review each against its manifest invariants. **EXCLUDE `boringstack build` per ag.**
1. `loop / turn` — `src/loop/turn.ts`, `session.ts`, `loop.types.ts`, `run.ts`
2. `loop / repair + snapshot` — `src/loop/file-snapshot.ts`, `quality.ts`, `review-repair.ts`
3. `loop / greenfield` — `src/loop/greenfield/*`  ← **just heavily changed by #105, review hard**
4. `tools` — `src/loop/tools/*`
5. `gate / detect-gate` — `src/gate/*`, `src/validate/*`  ← **#105 blast radius; top priority**
6. `oracles` — `scripts/boot-check.ts`, `src/browser/oracle.ts`, `scripts/*-check.ts`
7. `browser` — `src/browser/oracle.ts`
8. `inference / provider` — `src/inference/*`, request builder, stream guard
9. `rule-packs / meta-rules` — `src/meta-rules/*`, `src/rule-packs/*`, `src/infer-rules/*`, `scripts/build-rule-docs.ts`
10. `render / CLI` — `src/cli.ts`, `src/render/*`  ← **#105 touched `cli.ts` (--profile guard); review**
11. `editor` — `src/editor/*`
12. `policy` — `src/policy/*` (`policy.ts`, `classify.ts`, `patterns.ts`, `policy.types.ts`)
13. `agent / subagents` — `src/agent/*`, `src/cli/spawn-runner.ts`, `src/loop/tools/spawn-agent.ts`, `src/config/agent-specs.ts`, `src/render/agent-tree.ts`
14. `mcp` — `src/mcp/*`
15. `setup / conventions` — `src/infer-rules/*`, `src/setup/*`, `src/render/wizard.ts`, bundled `.mjs` configs
16. `lib/fs` — `src/lib/fs/process.ts`, fs helpers, `src/lib/scope/scope.ts`

**Also NOT in the manifest but core + #105-touched, review explicitly:**
`src/cli/args.ts`, `src/cli/repl.ts`, `src/cli/gate-setup.ts`, `src/session-store.ts`,
`src/config/profiles.ts`, `src/config/tsforge-config.ts`.
And check the manifest itself is not stale vs the code (the skill says a stale entry is a finding).

### Astro/Starlight doc pages to cross-reference — 46 files under `apps/docs/src/content/docs/`
```
agent/delegation.mdx        agent/model-agent.mdx        agent/skills-and-harness.mdx
big-picture.mdx             cli/interactive.mdx          cli/map.mdx
cli/plan-mode.mdx           cli/recipes.mdx              cli/review.mdx
cli/setup.mdx               edit/engine.mdx              eval/ab-testing.mdx
guardrails/config.mdx       guardrails/meta-rules.mdx    guardrails/policy.mdx
guardrails/rule-packs.mdx   guardrails/stack-detection.mdx  index.mdx
inference/adapter.mdx       inference/models-json.mdx    integrations/mcp.mdx
integrations/web-tools.mdx  loop/gate-floor.mdx          loop/greenfield.mdx
loop/scout.mdx              loop/spec-runner.mdx         loop/validation.mdx
lsp/typescript-server.mdx   observability/metrics.mdx    observability/trace.mdx
quality/tests.mdx           quickstart.mdx               reference/commands.mdx
reference/flags.mdx         reference/input-editor.mdx   reference/roadmap.mdx
reference/rules-catalog.md  scaffold/boringstack.mdx     spec/format.mdx
uplift/hashline.mdx         uplift/memory.mdx            uplift/repair-ladder.mdx
uplift/ttsr.mdx             uplift/write-diagnostics.mdx workflows/fix-to-green.mdx
```
(`scaffold/boringstack.mdx` — light touch only, adapter is out of scope, but flag drift.)

### Core `src/` top-level (for orientation)
`agent browser cli cli.ts codebase config constitution editor eval files gate index.ts
infer-rules inference lib loop lsp mcp meta-rules models-config.ts policy proptest render
reviewers rule-packs scaffold(excluded) self-harness session-store.ts setup spec
stack-detection update-check.ts validate`

## Approach

### Lens A — code review (panel + read-only subagents)
- **Panel:** run `harness-review` on each subsystem. Priority order (highest-risk first,
  from #105 lessons): `gate/detect-gate` → `cli`/args/repl/session-store/gate-setup →
  `loop/turn` → `loop/greenfield` → `policy` → `inference/provider` → `tools` → then the
  rest. Consider the skill's `all` fan-out, but per-subsystem gives cleaner, actionable output.
- **Subagents:** fan out **read-only `Explore`** agents (NOT `general-purpose` — a
  general-purpose agent once auto-pushed a PR; read-only only) to trace specific invariants
  the panel flags, and to hunt cross-cutting issues the per-subsystem panel can't see:
  gate-relaxation seams, silent truncation / swallowed errors, prototype-pollution-style
  `in`-operator lookups, `as` casts / eslint-disable (house rules), functions over cc 20,
  duplicated logic (DRY — #104), and unwired/dead exports.
- Verify each finding by reproducing it (smallest repro / focused test) before trusting it.

### Lens B — docs cross-reference (read-only subagents)
- Fan out read-only `Explore` agents, each owning a slice of the 46 doc pages. For every
  factual claim in a page, cross-reference the code: **flag names + values** (`reference/flags.mdx`,
  `reference/commands.mdx`), turn/write caps, gate stages, env vars (`TSFORGE_*`), model ids,
  file paths, command names, defaults, and any "how it works" claim.
- Known-good baseline to re-verify (already fixed in #98–#101): model refs → DeepSeek-V4-Flash;
  turn cap 1000; gate stages differential/reachability/testid/judge; write-diag cap 200;
  generic-ts contradiction; eval paths `evals/corpus/`. Confirm they stuck AND find NEW drift.
- **Known NEW drift to fix (0.35.0):** the `--profile <id>` CLI flag now exists (strictness:
  recommended|strict|security|frontend|backend|opinionated, persisted across `--continue`).
  It should be documented in `reference/flags.mdx` + `reference/commands.mdx` and likely
  `guardrails/rule-packs.mdx` / a profiles doc. Also the greenfield re-detect + strict-default
  + ruleset-keyed cache behavior (`loop/greenfield.mdx`, `guardrails/stack-detection.mdx`,
  `guardrails/config.mdx`) may need updating to match #105.

### Collate + land
- Produce ONE severity-sorted findings list (P1/P2/P3), each `file:line` + fix sketch.
- Fix in **small, focused, panel-gated PRs** (code fixes and docs fixes separate). Each PR:
  `bun run validate` green + panel PASS (reviewers ok ≥ 2) before ag's signed merge.
- New backlog tasks for anything not fixed inline.

## Hard constraints / gotchas (from memory — do not relearn these)
- **NEVER relax the gate** (no downgrading rules/severity/warnings). Root-cause at source; band-aids are rejected.
- **Review through the OWN 4-model panel**, not Claude subagents-as-reviewers. Subagents are for tracing/exploration, not the verdict.
- **Read-only `Explore` agents for fan-out**, never `general-purpose` (auto-push incident).
- **House rules:** no `as` casts (except `as const`), no `eslint-disable`, cyclomatic complexity ≤ 20, shared AST walkers / `serveEphemeral` / `runArgvCommand` over re-rolling; run full `bun run validate` before "done".
- **DRY (ag's standing bar):** never repeat the same logic; extract shared helpers (e.g. `isWin32()` in `lib/platform.ts`). Duplication audit is task #104.
- **Signed commits/tags + merges + releases are AG's.** Never direct-push or merge to main. Release: `./scripts/release.sh minor --yes` from main (signed, npm + GitHub Release; origin=https).
- Use **absolute clickable paths** (Cmd+click), append `:line`.
- Panels/builds reap ~10–15 min; don't switch branches mid-panel; clear `.tsforge/harness-review/*.json` between panel runs.

## How to resume (fresh session, cold)
1. Read: this file, memory `greenfield-gate-redetect-strict.md`, `tsforge-north-star.md`,
   `use-the-reviewer-panel.md`, `review-with-readonly-agents.md`, and the `harness-review`
   skill (`.claude/skills/harness/harness-review/SKILL.md`) + `docs/harness-subsystems.md`.
2. Confirm `main`, clean, 0.35.0.
3. **Lens A:** start the panel on `gate/detect-gate`, then the `cli` seam files; in parallel,
   fan out read-only Explore agents for the cross-cutting hunts above.
4. **Lens B:** fan out read-only Explore agents over the 46 doc pages (slice by top-level dir).
5. Collate → severity-sorted findings → small panel-gated PRs (ag signs) → new tasks for the rest.

## Out of scope (this pass)
- BoringStack adapter (`src/scaffold/*`, `src/loop/boringstack/*`, `scaffold/boringstack.mdx` fixes).
- The deferred #93 app-own-layout feature; #77 near-green determinism; the resume "fortress".
