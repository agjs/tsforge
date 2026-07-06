---
name: effective-tsforge-skills
description: How to write and maintain tsforge agent skills — when to use a skill vs a rule vs a recipe vs docs, description routing, progressive disclosure, and the ship checklist. Use when creating, editing, or reviewing SKILL.md files under .claude/skills/, or when asked "should this be a skill?".
---

# Effective tsforge skills

tsforge is **enforcement-first**: the gate, rule packs, and `rule-docs` bad/good cards are the runtime oracle. Skills are **maintainer and IDE affordances** — procedures the harness does not load. Write skills for repeatable human/agent workflows; write rules for anything that must hold whether or not the model remembers.

## When to use what

| Need                                          | Use                                                 | Lives in                                       |
| --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Must be true before "done"                    | ESLint rule, meta-rule, or gate check               | `packages/core/src/rule-packs/`, `meta-rules/` |
| Fix guidance on gate failure                  | `IRuleDoc` (what + bad + good + optional procedure) | `packages/core/src/loop/feedback/rule-docs.ts` |
| Named run setup (flags, gate, model)          | Recipe JSON                                         | `.tsforge/recipes/*.json`                      |
| Maintainer procedure (release, harness audit) | Skill                                               | `.claude/skills/<category>/<name>/SKILL.md`    |
| User-facing product docs                      | Starlight page                                      | `apps/docs/src/content/docs/`                  |

**Do not** put enforceable invariants only in a skill. **Do not** duplicate `AGENTS.md` house rules in skills — they are already in prompts and ESLint.

## Category taxonomy

```
.claude/skills/
├── harness/     # adversarial subsystem review (harness-review)
├── release/     # npm + GitHub release (tsforge-release)
├── authoring/   # this skill, rules-build helpers
└── workflow/    # eval sweep, spec loop (when committed)
```

Folder name must **exactly match** frontmatter `name`. File must be `SKILL.md`.

## Description as routing contract

The `description` is the only discovery surface. Include:

1. **What** the skill does (one phrase)
2. **When** / trigger phrases the user will say
3. **Differentiator** vs sibling skills

Describe _what_ and _when_, never _how_. A step-by-step summary in `description` makes agents skip the body.

## Two patterns

**Capability primitives** — bash/scripts, exact commands, failure modes. Example: `tsforge-release` → `scripts/release.sh`.

**Process primitives** — methodology, checklists, output templates. Example: `harness-review` → repro-before-report.

Use `disable-model-invocation: true` for manual-only skills (release, handoff-style) so they do not auto-fire mid-task.

## Progressive disclosure

Keep `SKILL.md` lean. Push install detail, format specs, and long references to `references/` and link with explicit "read when" pointers. One level deep only — no reference chains.

Pack-level deep guidance belongs in rule pack `references/`, surfaced via `IRuleDoc.reference`, not in always-on prompts.

## Composition map

| Skill                      | Reads / invokes                                       |
| -------------------------- | ----------------------------------------------------- |
| `harness-review`           | `docs/harness-subsystems.md`                          |
| `tsforge-release`          | `scripts/release.sh`, `.github/workflows/release.yml` |
| `effective-tsforge-skills` | (this file)                                           |

Recipes compose CLI knobs; skills compose procedures. Cross-reference by skill `name`, do not duplicate bodies.

## Ship checklist

- [ ] `name` matches parent folder name
- [ ] Description: what + when + differentiator (no how-to summary)
- [ ] Output format documented if the skill produces structured findings
- [ ] Validation loop: what command proves success (`bun run validate` for code changes)
- [ ] Repro required before reporting harness bugs (see `harness-review`)
- [ ] No human-facing README inside the skill folder
- [ ] Relative paths from repo root (`scripts/…`, not `../../../../scripts/…`)

## Anti-patterns

- Runtime skill loading in `packages/core` — conflicts with enforcement-first design
- Monolithic mega-skills — split by concern; recipes + skills compose at use time
- Re-teaching TypeScript or git basics the model already knows
- Skills that only restate `AGENTS.md` without a procedure
