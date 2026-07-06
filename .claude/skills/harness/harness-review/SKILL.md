---
name: harness-review
description: Adversarially review one tsforge harness subsystem (or all) against its invariants. Use when asked to "review the harness", "audit a subsystem", "check the gate/tools/loop/process layer", or before a release. Reads source + tests, checks each invariant, repros suspected breaks, and returns a structured findings list.
---

# Harness review

Review the tsforge harness one subsystem at a time against its **contracts**, the way
the codex pass that found the scaffold_web and process-group bugs did. The goal is
verified findings, not vibes: a finding is real only once you've reproduced it or
traced it to a concrete `file:line`.

## Inputs

- A subsystem name from `docs/harness-subsystems.md` (e.g. `tools`, `lib/fs`, `loop`,
  `gate`, `oracles`, `browser`, `inference`, `rules`, `cli`, `mcp`, `web-scaffold`), or
- `all` — review every subsystem (fan out; see below).

## Procedure (one subsystem)

1. **Load the contract.** Read that subsystem's entry in `docs/harness-subsystems.md` —
   its source globs, invariants, risk areas, checklist. If the entry looks stale versus
   the code, note it as a finding (the manifest is part of the contract).
2. **Read the source AND its tests.** Don't skim. For each invariant, find the lines
   that are supposed to uphold it. Absence of a test for an invariant is itself a P2.
3. **Be adversarial.** For each invariant assume it's violated until the code proves
   otherwise. Walk the failure modes in "Risk areas". Ask: what input, ordering, env,
   or platform makes this break? Mutation that doesn't re-gate? A kill that leaks a
   child? Text that lies about state? A guard a forced/salvaged call routes around?
4. **Reproduce.** For any suspected break, write the smallest repro — a throwaway
   `bun` script or a focused test in a temp dir. A repro that fires is a P1/P2; one that
   doesn't clears the hunch (say so). Never report an unreproduced "could be".
5. **Report.** Return a findings list using the output template below.

   If the subsystem is clean, say so explicitly and list which invariants you verified
   and how — "clean" with no evidence is not an acceptable result.

## Procedure (`all`)

Fan out: one focused review per subsystem (use the Agent tool — or a Workflow if the
user opted into multi-agent orchestration), each running the single-subsystem
procedure on its own slice, then collate into one severity-sorted list with a short
per-subsystem "verified / findings" summary. This is opt-in per run (it spawns many
agents); don't trigger it automatically.

## Output template

Return findings in this shape (highest severity first):

```markdown
## Harness review: <subsystem>

### Findings

#### P1 — <title>
- **location:** `path/to/file.ts:42`
- **evidence:** <repro steps or quoted code path>
- **fix:** <concrete sketch + regression test name>

#### P2 — …

### Verified (if clean)
- <invariant>: checked via <how>
```

## Output discipline

- Quote real emission strings/identifiers before matching on them — grep the source,
  don't guess keywords (a wrong keyword reads as "clean" when it isn't).
- Distinguish "I verified X holds" (with how) from "X looks fine" (didn't check).
- Tie every fix to a regression test; an un-tested fix is half a fix.
- Respect the house rules when sketching fixes: no `as` casts, no eslint-disable,
  cyclomatic complexity ≤ 20, reuse the shared AST walkers / `serveEphemeral` /
  `runArgvCommand` rather than re-rolling them.

## Verify the skill itself

After a review, the user should be able to run `bun run validate` and see any fix you
landed reflected as a green regression test. If a "finding" can't be turned into a
failing-then-passing test, treat it as unproven.
