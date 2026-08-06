# tsforge monorepo

Single repository: `packages/core` (harness), `apps/docs` (Starlight site).

## Maintainer commands (repo root)

```bash
bun run validate                              # merge gate — run before every push
bun test packages                             # full test suite (680+ tests)
tsforge                                       # run harness (after install or bun link)
bun run tsforge                               # run harness from monorepo checkout
bun run rules:build                           # regenerate RULES.md
bun run rules:docs                            # regenerate rule-docs.generated.json
bun run eval:sweep                            # A/B feature sweep (see tsforge.dev/eval/ab-testing/)
bun run eval:benchmark                        # compare edit mechanisms across runs
./scripts/audit-repo-settings.sh             # diff GitHub repo settings vs .github/desired-repo-settings.json
./scripts/release.sh patch                   # bump, tag, push → npm + GitHub Release (see .claude/skills/release/tsforge-release/)
```

## Layout

| Path | Role |
| --- | --- |
| `packages/core/src/stack-detection/` | detect stack, enable rule packs |
| `packages/core/src/rule-packs/` | ESLint rule pack implementations (13 packs) |
| `packages/core/src/meta-rules/` | non-AST gate rules (config, CI, supply chain) |
| `packages/core/src/config/` | runtime flags, tsforge.config.json loader |
| `packages/core/src/files/` | edit, create, hashline |
| `packages/core/src/inference/` | model adapter, stream guard |
| `packages/core/src/loop/` | implement loop, TTSR, validation |
| `packages/core/src/lsp/` | LSP tools + write feedback |
| `packages/core/src/agent/` | ModelAgent, tool-call repair ladder |
| `packages/core/scripts/` | eval, sweep, doc generators |
| `packages/core/src/validate/` | gate runner, error parsers |
| `apps/docs/` | Astro Starlight docs site |

CI: run `bun run validate` locally; no remote CI wired yet.

Remote: https://github.com/agjs/tsforge

## House rules

- No `as` type assertions — narrow with guards
- No `eslint-disable` — fix the root cause
- Cyclomatic complexity ≤ 20
- Interfaces prefixed `I`; types live in `*.types.ts`
- No new logic file without a behavioral test sibling
- **A test is not coverage until it has failed.** Before claiming a line is
  tested, break it and watch the test go red. `expect(x).toBeDefined()` passes
  against `{}` as readily as against the value you meant, so an assertion that
  cannot fail proves nothing about the line beneath it.
- **Never describe a change you have not read back.** A scripted edit that
  matches nothing fails silently, so `grep` the new text before writing it into
  a commit message. Four commits in one session described fixes that were never
  in the file.
- **Scripts orchestrate; `src/` decides.** A file in `scripts/` is an entry
  point — parse args, call into `src/`, print. Any function it would be a bug to
  get wrong belongs in `src/`, where a test can import it. The graded score
  reached the acceptance rule for a week only in theory, because the merge step
  that dropped it sat in a script.
