#!/bin/sh
# Build the git history for this brownfield seed:
#   HEAD~1 = the KNOWN-GOOD slugify ; HEAD = an unrelated commit ;
#   working tree = the BUGGY slug.ts (the seed file, left uncommitted).
# So the regression is exactly `git diff` (good → buggy), and `git log` / `git
# show HEAD~1` reveal the last working version — what git_context exists to surface.
set -e
git init -q
git config user.email "eval@tsforge.local"
git config user.name "tsforge-eval"

# Stash the buggy working version (the seed's slug.ts — what the model must fix).
cp slug.ts .slug.buggy

# Commit the known-good version as history.
cat > slug.ts <<'GOOD'
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
GOOD
git add -A
git commit -q -m "slug: working slugify (collapses runs to one hyphen)"
git commit -q --allow-empty -m "docs: note slug usage"

# Restore the buggy version as an uncommitted change → the RED working tree.
mv .slug.buggy slug.ts
