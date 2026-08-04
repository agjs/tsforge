import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isWin32 } from "../platform";

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

/** The monorepo root's package name. Climbing "while ancestors have manifests"
 *  does not reach it — `packages/` carries none — and climbing past that would
 *  swallow a CONSUMER's repo when tsforge is installed as a dependency, turning
 *  the guard off exactly where it is needed. Matching the name is precise. */
const HARNESS_PACKAGE_NAME = "tsforge";

function manifestName(dir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8")
    );

    return typeof raw === "object" && raw !== null && "name" in raw
      ? String(raw.name)
      : undefined;
  } catch {
    // No manifest, or one that does not parse. Neither identifies a root.
    return undefined;
  }
}

/** The harness's own roots, computed once from this module's location: the
 *  package it ships in, plus the monorepo root when running from source. */
function computeHarnessRoots(): string[] {
  const roots: string[] = [];
  let dir = import.meta.dir;

  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);

    if (parent === dir) {
      return roots;
    }

    dir = parent;
  }

  roots.push(dir);

  for (let cur = dir; ;) {
    const parent = dirname(cur);

    if (parent === cur) {
      return roots;
    }

    cur = parent;

    if (manifestName(cur) === HARNESS_PACKAGE_NAME) {
      roots.push(cur);

      return roots;
    }
  }
}

let cachedRoots: string[] | null = null;

function harnessRoots(): string[] {
  cachedRoots ??= computeHarnessRoots();

  return cachedRoots;
}

/** True when `child` is `parent` or sits underneath it.
 *
 * Segment-wise, so a sibling whose name merely starts the same
 * (`/code/tsforge-notes` next to `/code/tsforge`) is not a match, and a name
 * that merely begins with two dots (`..notes.ts`) is not read as an escape.
 * An ABSOLUTE result means no relative path exists at all — Windows returns one
 * for a cross-drive pair — which is the opposite of containment. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  if (rel === "") {
    return true;
  }

  if (isAbsolute(rel)) {
    return false;
  }

  const segments = isWin32() ? rel.split(/[\\/]/u) : rel.split("/");

  return !segments.includes("..");
}

/**
 * True when reading this path would open the harness's own source from a
 * workspace that is not the harness.
 *
 * `file` may be absolute or relative to `cwd`; both resolve to the same answer.
 */
export function isForeignHarnessRead(cwd: string, file: string): boolean {
  const roots = harnessRoots();
  const target = resolve(cwd, file);
  const workspace = resolve(cwd);

  const insideHarness = roots.some((root) => contains(root, target));

  // Overlap with ANY root, in EITHER direction, means the harness is the
  // project in hand: the workspace may be the monorepo root, the shipped
  // package, or a sibling package beside it. Asking this per-root and OR-ing
  // the refusals instead would flag a sibling package, which is disjoint from
  // `packages/core` while plainly being harness work.
  const workingOnHarness = roots.some(
    (root) => contains(workspace, root) || contains(root, workspace)
  );

  return insideHarness && !workingOnHarness;
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

/** A shell token that looks like a filesystem path rather than a flag, an
 *  operator, or a bare command name. */
function isPathLike(token: string): boolean {
  if (token === "" || token.startsWith("-")) {
    return false;
  }

  return token.includes("/") || token.includes("\\");
}

/**
 * The harness path a shell command would read, if any.
 *
 * `read` refusing while `cat` succeeds would be theatre — the same bytes, one
 * door over. Every path-shaped token is checked, not just the ones belonging to
 * known readers, because the argument order of an arbitrary command is not
 * knowable and a token pointing INTO the harness has no other purpose here.
 */
export function foreignHarnessShellRead(
  cwd: string,
  command: string
): string | null {
  const tokens = command
    .split(/[\s;|&<>()"']+/u)
    .filter((token) => isPathLike(token));

  return tokens.find((token) => isForeignHarnessRead(cwd, token)) ?? null;
}
