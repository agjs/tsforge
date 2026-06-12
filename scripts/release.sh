#!/usr/bin/env bash
#
# Full release pipeline: validate, commit pending work, bump version, sign tag,
# push — triggers .github/workflows/release.yml (npm publish + GitHub Release).
# Requires: git, jq, bun, gh (authenticated).
#
# Usage:
#   ./scripts/release.sh patch              # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor              # 0.1.0 → 0.2.0
#   ./scripts/release.sh major              # 0.1.0 → 1.0.0
#   ./scripts/release.sh --version 0.2.0    # explicit semver
#   ./scripts/release.sh --tag-only         # tag current package.json version
#   ./scripts/release.sh patch --dry-run    # print plan only
#
# Options:
#   --dry-run         show actions, change nothing
#   --skip-validate   skip bun run validate
#   --tag-only        do not bump; tag packages/core version as-is
#   --no-push         commit + tag locally, do not push
#   --yes             skip confirmation prompt
#   -h, --help        usage

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
CORE_PKG="$ROOT/packages/core/package.json"
ROOT_PKG="$ROOT/package.json"
APPS_DOCS_PKG="$ROOT/apps/docs/package.json"

DRY_RUN=0
SKIP_VALIDATE=0
TAG_ONLY=0
NO_PUSH=0
ASSUME_YES=0
EXPLICIT_VERSION=""
BUMP_KIND=""

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

semver_bump() {
  local current="$1" kind="$2"
  local major minor patch
  IFS=. read -r major minor patch <<<"${current%%-*}"
  patch=${patch%%[^0-9]*}

  case "$kind" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
    *) die "unknown bump kind: $kind" ;;
  esac

  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

set_version() {
  local version="$1"
  local tmp
  tmp=$(mktemp)
  jq --arg v "$version" '.version = $v' "$CORE_PKG" >"$tmp" && mv "$tmp" "$CORE_PKG"
  jq --arg v "$version" '.version = $v' "$ROOT_PKG" >"$tmp" && mv "$tmp" "$ROOT_PKG"
  if [[ -f "$APPS_DOCS_PKG" ]]; then
    jq --arg v "$version" '.version = $v' "$APPS_DOCS_PKG" >"$tmp" && mv "$tmp" "$APPS_DOCS_PKG"
  fi
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

tree_has_changes() {
  ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]
}

commit_all() {
  local message="$1"
  if tree_has_changes; then
    info "Committing pending changes..."
    run git add -A
    run git commit -S -m "$message"
  else
    info "Nothing to commit (tree already clean)."
  fi
}

sync_with_origin_main() {
  local behind ahead
  behind=$(git rev-list --count HEAD..origin/main)
  ahead=$(git rev-list --count origin/main..HEAD)

  if [[ "$behind" -gt 0 && "$ahead" -gt 0 ]]; then
    die "main diverged from origin/main (${ahead} ahead, ${behind} behind); resolve manually"
  fi

  if [[ "$behind" -gt 0 ]]; then
    info "Rebasing onto origin/main (${behind} commit(s) behind)..."
    run git pull --rebase origin main
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch | minor | major)
      BUMP_KIND="$1"
      shift
      ;;
    --version)
      [[ $# -ge 2 ]] || die "--version requires a value"
      EXPLICIT_VERSION="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-validate) SKIP_VALIDATE=1; shift ;;
    --tag-only) TAG_ONLY=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    -h | --help) usage 0 ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

cd "$ROOT"

command -v jq >/dev/null || die "jq is required"
command -v bun >/dev/null || die "bun is required"
command -v gh >/dev/null || die "gh is required (authenticated)"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"

branch=$(git symbolic-ref --quiet --short HEAD || true)
[[ "$branch" == "main" ]] || die "must be on main (currently: ${branch:-detached HEAD})"

if [[ "$DRY_RUN" -eq 0 ]]; then
  git fetch origin main
else
  printf '[dry-run] git fetch origin main\n'
fi

CURRENT=$(jq -r '.version' "$CORE_PKG")
ROOT_CURRENT=$(jq -r '.version' "$ROOT_PKG")
[[ "$CURRENT" == "$ROOT_CURRENT" ]] || die "version mismatch: packages/core=$CURRENT root=$ROOT_CURRENT"

if [[ "$TAG_ONLY" -eq 1 ]]; then
  NEW_VERSION="$CURRENT"
elif [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="$EXPLICIT_VERSION"
elif [[ -n "$BUMP_KIND" ]]; then
  NEW_VERSION=$(semver_bump "$CURRENT" "$BUMP_KIND")
else
  usage 1
fi

TAG="v${NEW_VERSION}"
COMMIT_MSG="chore: release ${NEW_VERSION}"

if [[ "$TAG_ONLY" -eq 0 && "$NEW_VERSION" == "$CURRENT" ]]; then
  die "new version equals current ($CURRENT); use --tag-only to re-tag"
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists locally"
fi

if [[ "$SKIP_VALIDATE" -eq 0 ]]; then
  info "Running bun run validate..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] bun run validate\n'
  else
    bun run validate
  fi
else
  warn "skipping validate (--skip-validate)"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! gh secret list 2>/dev/null | grep -q '^NPM_TOKEN'; then
    warn "NPM_TOKEN secret not found on GitHub; release workflow will fail at npm publish"
  fi
fi

info "Release plan:"
printf '  current:   %s\n' "$CURRENT"
printf '  release:   %s (%s)\n' "$NEW_VERSION" "$TAG"
printf '  tag-only:  %s\n' "$([[ "$TAG_ONLY" -eq 1 ]] && echo yes || echo no)"
printf '  uncommitted changes: %s\n' "$(tree_has_changes && echo yes || echo no)"
printf '  push:      %s\n' "$([[ "$NO_PUSH" -eq 1 ]] && echo no || echo yes)"

if [[ "$ASSUME_YES" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "aborted"
fi

if [[ "$TAG_ONLY" -eq 0 ]]; then
  info "Bumping version to $NEW_VERSION..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] set_version %s\n' "$NEW_VERSION"
  else
    set_version "$NEW_VERSION"
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  if tree_has_changes || [[ "$TAG_ONLY" -eq 0 ]]; then
    printf '[dry-run] git add -A && git commit -S -m %q\n' "$COMMIT_MSG"
  fi
else
  commit_all "$COMMIT_MSG"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '[dry-run] sync_with_origin_main\n'
else
  sync_with_origin_main
fi

info "Creating signed tag $TAG..."
run git tag -s "$TAG" -m "Release ${NEW_VERSION}"

if [[ "$NO_PUSH" -eq 1 ]]; then
  info "Skipping push (--no-push). When ready:"
  printf '  git push origin main\n'
  printf '  git push origin %s\n' "$TAG"
  exit 0
fi

info "Pushing main..."
run git push origin main

info "Pushing tag $TAG..."
run git push origin "$TAG"

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry run complete."
  exit 0
fi

info "Waiting for release workflow..."
sleep 3
run_id=$(gh run list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')

if [[ -z "$run_id" || "$run_id" == "null" ]]; then
  warn "could not find release workflow run; check https://github.com/agjs/tsforge/actions"
  exit 0
fi

if gh run watch "$run_id" --exit-status; then
  info "Release workflow succeeded."
  gh release view "$TAG" --web 2>/dev/null || gh release view "$TAG"
  printf '\nInstall: bun install -g tsforge@%s\n' "$NEW_VERSION"
else
  die "release workflow failed. See: gh run view $run_id --log-failed"
fi
