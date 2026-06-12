# tsforge monorepo

Single repository: `packages/core` (harness), `apps/docs` (Starlight site).

## Maintainer commands (repo root)

```bash
bun run validate                              # merge gate — run before every push
bun test packages                             # full test suite (680+ tests)
bun run typecheck                             # tsc packages/core
bun run lint                                  # eslint packages
bun run format:check                          # prettier check
bun packages/core/scripts/build-rules-md.ts   # regenerate RULES.md
bun packages/core/scripts/build-rule-docs.ts  # regenerate rule-docs.generated.json
bun packages/core/scripts/sweep.ts            # A/B feature sweep (see EVAL_GUIDE.md)
bun packages/core/scripts/edit-benchmark.ts   # compare edit mechanisms across runs
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
