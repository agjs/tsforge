---
name: tsforge-release
description: End-to-end tsforge release — validate, commit pending work, bump version, signed tag, push, watch npm publish. Use when the user asks to release, publish, ship, tag, or cut a version. Does not require a clean git tree. Manual-only; do not auto-run during unrelated tasks.
disable-model-invocation: true
---

# tsforge release

One command from dirty `main` to npm + GitHub Release. Pushing `v*.*.*` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml).

**The script commits everything for you.** Uncommitted work is included in the release commit. You do not need a clean tree first.

## Run it

```bash
./scripts/release.sh --tag-only --yes   # first publish at current version (e.g. 0.1.0)
./scripts/release.sh patch --yes          # later: 0.1.0 → 0.1.1
./scripts/release.sh minor --yes
./scripts/release.sh major --yes
./scripts/release.sh patch --dry-run      # preview only
```

## What the script does (in order)

1. Requires `main` branch
2. `git fetch origin main`
3. `bun run validate` (unless `--skip-validate`)
4. Bumps version in `packages/core`, root, and `apps/docs` package.json (unless `--tag-only`)
5. `git add -A` + signed commit: `chore: release X.Y.Z` (pending work + version bump together)
6. Rebases onto `origin/main` if behind
7. Signed tag `vX.Y.Z`
8. Pushes `main` + tag
9. Watches `release.yml` via `gh run watch`

Flags: `--dry-run`, `--no-push`, `--yes`, `--tag-only`, `--skip-validate`.

## Prerequisites

| Requirement | Check |
| ----------- | ----- |
| `gh` authenticated | `gh auth status` |
| Signed commits/tags | `git commit -S` and `git tag -s` must work |
| `NPM_TOKEN` on GitHub | `gh secret list \| grep NPM_TOKEN` |
| On `main` | not a feature branch |

## Agent workflow

When the user asks to release, run the script. Do not ask them to commit first.

1. `git branch --show-current` (must be `main`; checkout `main` if they explicitly want to release from current work)
2. `jq -r .version packages/core/package.json`
3. Choose bump: first npm publish → `--tag-only`. Otherwise `patch` / `minor` / `major` unless they specify.
4. Run `./scripts/release.sh <bump> --yes`
5. On failure: `gh run view --log-failed` on the release workflow
6. Report: `bun install -g @agjs/tsforge@VERSION`

Do not manually `npm publish` unless the user explicitly asks to bypass CI.

## Version rules

- Tag must match `packages/core/package.json` without the `v` prefix
- Only tag pushes release (not every merge to `main`)
- `--tag-only` for first publish when version is already set (e.g. `0.1.0`)

## Troubleshooting

| Failure | Fix |
| ------- | --- |
| `must be on main` | `git checkout main` |
| `main diverged from origin/main` | resolve rebase conflict, re-run |
| `tag vX.Y.Z already exists` | next semver or delete abandoned tag |
| npm publish 401/403 | Regenerate `NPM_TOKEN`: granular token with **Read and write**, **All packages**, **Bypass 2FA for automation** (or classic Automation token). Verify npm email. `gh secret set NPM_TOKEN` |
| npm publish 403 name conflict | Unscoped `tsforge` conflicts with `ts-forge` on npm — publish as `@agjs/tsforge` |
| unsigned commit rejected | enable GPG/SSH signing |

## Related docs

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [apps/docs/DEPLOY.md](apps/docs/DEPLOY.md)
