import { join } from "node:path";
import { statSync } from "node:fs";
import { runArgvCommand } from "../lib/fs";

/**
 * Git-backed dirty-package detection for the workspace-container gate.
 *
 * The gate's `touched` set records only EDIT/CREATE TOOL writes — a file the
 * model changes through the shell tool (`sed -i`, a codegen script,
 * `git apply`) never registers, so the container gate green-skipped real
 * changes ("no package edited") and persisted the vacuous accept. This module
 * detects changes the tool path can't see: a per-child baseline is captured at
 * session gate start, and each settle diffs against it — any child whose git
 * state moved since the baseline is gated, however the bytes got there.
 *
 * Baseline DIFFING (not absolute dirtiness) means a user's pre-existing dirty
 * tree does not drag every package into every settle — only changes since the
 * session started do. The baseline value hashes `git status --porcelain
 * --untracked-files=all` PLUS `git rev-parse HEAD`, so a write followed by a
 * commit inside the child repo (status clean again) still counts as dirty.
 *
 * Fail closed everywhere: a child that isn't a git repo falls back to an
 * mtime scan; a child whose detection errors, or that appeared after the
 * baseline, is treated as dirty.
 */

/** Sentinel baseline for a child where git is unavailable/not a repo. */
export const NO_GIT = "no-git";

const GIT_TIMEOUT_MS = 15_000;

/** Code + config files the mtime fallback watches (mirrors the gate's
 *  typecheck/lint surface plus the manifests that change its shape). */
const FALLBACK_GLOB = "**/*.{ts,tsx,js,jsx,cts,mts,cjs,mjs,json}";

/** Entry cap for the mtime fallback scan — beyond it we stop scanning and
 *  treat the package as dirty (fail closed) rather than pay an unbounded walk. */
const FALLBACK_SCAN_CAP = 20_000;

async function gitStateHash(child: string): Promise<string> {
  const status = await runArgvCommand(
    child,
    ["git", "status", "--porcelain", "--untracked-files=all"],
    { timeoutMs: GIT_TIMEOUT_MS }
  );

  if (status.exitCode !== 0) {
    return NO_GIT;
  }

  const head = await runArgvCommand(child, ["git", "rev-parse", "HEAD"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  // An empty repo (no commits yet) has no HEAD — fold the error text in; it is
  // stable until the first commit, which then changes the hash (dirty). Good.
  const headId = head.exitCode === 0 ? head.stdout.trim() : "no-head";

  return Bun.hash(`${headId}\n${status.stdout}`).toString(36);
}

/** Capture the per-child baseline at session gate start. */
export async function captureDirtyBaseline(
  children: readonly string[]
): Promise<Map<string, string>> {
  const baseline = new Map<string, string>();

  for (const child of children) {
    try {
      baseline.set(child, await gitStateHash(child));
    } catch {
      baseline.set(child, NO_GIT);
    }
  }

  return baseline;
}

/** Mtime fallback for a non-git child: true when any watched file changed
 *  after `sinceMs` (early exit), or the scan hit the cap (fail closed). */
async function mtimeDirty(child: string, sinceMs: number): Promise<boolean> {
  const glob = new Bun.Glob(FALLBACK_GLOB);
  let seen = 0;

  for await (const path of glob.scan({ cwd: child, onlyFiles: true })) {
    if (path.includes("node_modules") || path.startsWith(".")) {
      continue;
    }

    seen += 1;

    if (seen > FALLBACK_SCAN_CAP) {
      return true;
    }

    try {
      if (statSync(join(child, path)).mtimeMs > sinceMs) {
        return true;
      }
    } catch {
      // File vanished mid-scan — a change by definition.
      return true;
    }
  }

  return false;
}

/** Give baseline entries to children that appeared after capture (a clone, a
 *  scaffold) so later cycles DIFF their state instead of always including them.
 *  Their appearance itself is caught by `detectDirtyPackageRoots` (no entry ⇒
 *  dirty) on the cycle before this runs. */
export async function rememberNewChildren(
  baseline: Map<string, string>,
  children: readonly string[]
): Promise<void> {
  for (const child of children) {
    if (!baseline.has(child)) {
      try {
        baseline.set(child, await gitStateHash(child));
      } catch {
        baseline.set(child, NO_GIT);
      }
    }
  }
}

export interface IDirtyDetection {
  /** Child package roots (absolute) whose state moved since the baseline. */
  readonly dirty: string[];
  /** Human-readable notes for fail-closed inclusions (new child, scan cap…). */
  readonly notices: string[];
}

/**
 * Child packages whose state changed since the baseline. `children` is the
 * CURRENT child list (re-listed each settle) — a child with no baseline entry
 * appeared mid-session (a clone, a scaffold) and is dirty by definition; it
 * gains a baseline entry via `rememberBaseline` after its first gated cycle.
 */
export async function detectDirtyPackageRoots(
  children: readonly string[],
  baseline: ReadonlyMap<string, string>,
  sinceMs: number
): Promise<IDirtyDetection> {
  const dirty: string[] = [];
  const notices: string[] = [];

  for (const child of children) {
    const base = baseline.get(child);

    if (base === undefined) {
      dirty.push(child);
      notices.push(`${child}: appeared after session start — included`);
      continue;
    }

    try {
      if (base === NO_GIT) {
        if (await mtimeDirty(child, sinceMs)) {
          dirty.push(child);
        }
      } else if ((await gitStateHash(child)) !== base) {
        dirty.push(child);
      }
    } catch {
      dirty.push(child);
      notices.push(`${child}: dirty-detection failed — included to be safe`);
    }
  }

  return { dirty: dirty.sort(), notices };
}
