import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Stop the harness reading its OWN implementation while it works on someone
 * else's code.
 *
 * This is not a general sandbox — reads are otherwise unrestricted, and a path
 * the user names stays readable. It closes one specific failure that was
 * observed: a rule's guidance promised an escape hatch the rule did not have,
 * the model could not satisfy the gate, and it went looking for the answer in
 * tsforge's own source. That is never the fix. The rule's real behaviour has to
 * reach the model through its feedback, and when it does not, reading the
 * implementation only produces a workaround shaped around a bug.
 *
 * The exception that makes this safe: when the workspace IS the harness, every
 * read is ordinary work. Developing tsforge with tsforge is the normal case
 * here, so the check is about whether the harness source belongs to the project
 * in hand, not about which files they are.
 */

/** The harness's own package root(s), computed once from this module's location.
 *
 * Walks up while ancestors keep declaring themselves packages, so both layouts
 * are covered: an installed single package, and this monorepo, where
 * `packages/core` and the repo root each carry a `package.json`. */
function computeHarnessRoots(): string[] {
  const roots: string[] = [];
  let dir = import.meta.dir;

  // Find the nearest package root.
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);

    if (parent === dir) {
      return roots;
    }

    dir = parent;
  }

  roots.push(dir);

  // Then keep climbing while the ancestors are packages too (a workspace root).
  for (;;) {
    const parent = dirname(dir);

    if (parent === dir || !existsSync(join(parent, "package.json"))) {
      return roots;
    }

    dir = parent;
    roots.push(dir);
  }
}

let cachedRoots: string[] | null = null;

function harnessRoots(): string[] {
  cachedRoots ??= computeHarnessRoots();

  return cachedRoots;
}

/** True when `child` is `parent` or sits underneath it. Segment-wise via
 *  `relative`, so a sibling directory whose name merely starts the same
 *  (`/code/tsforge-notes` next to `/code/tsforge`) is not a match. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * True when reading this path would open the harness's own source from a
 * workspace that is not the harness.
 *
 * `file` may be absolute or relative to `cwd`; both resolve to the same answer.
 */
export function isForeignHarnessRead(cwd: string, file: string): boolean {
  const target = resolve(cwd, file);
  const workspace = resolve(cwd);

  return harnessRoots().some(
    // Overlap in EITHER direction means the harness is the project in hand:
    // the workspace may be the repo root, or a package inside it. Only a
    // workspace disjoint from the harness is reaching outside its own work.
    (root) =>
      contains(root, target) &&
      !contains(workspace, root) &&
      !contains(root, workspace)
  );
}

/** What to say instead of the file. The model reached for the source because
 *  the feedback it had was not enough, so pointing it back at the same feedback
 *  is useless — this names the two things that ARE actionable. */
export function foreignHarnessReadRefusal(file: string): string {
  return (
    `read: ${file} is tsforge's own source, not part of this workspace.\n` +
    `Reading it cannot fix the task: the gate runs the rule as it is, so a ` +
    `workaround shaped around the implementation still fails.\n` +
    `If a rule's message and guidance are not enough to satisfy it, the ` +
    `guidance is the bug. Say so in your answer, take the closest correct ` +
    `approach the rule does allow, and leave the rule alone.`
  );
}
