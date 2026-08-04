import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Follow symlinks where possible. A link inside the workspace pointing at the
 *  harness resolves to the same bytes, and comparing the link's own path would
 *  miss it. Paths that do not exist keep their resolved form — `run` is checked
 *  before anything runs, so its targets may legitimately be absent. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when reading this path would open the harness's own source from a
 * workspace that is not the harness.
 *
 * `file` may be absolute or relative to `cwd`; both resolve to the same answer.
 * `roots` is injectable so the install layouts can be tested directly.
 */
export function isForeignRead(
  roots: readonly string[],
  cwd: string,
  file: string
): boolean {
  const target = realpathOrSelf(resolve(cwd, file));
  const workspace = realpathOrSelf(resolve(cwd));

  const insideHarness = roots.some((root) => contains(root, target));

  // The workspace must be INSIDE a root — the monorepo root, the package, or
  // anything under them, which covers a sibling package and the repo root
  // itself since that is a root. Accepting "the workspace CONTAINS a root" as
  // well is what disabled the guard where it matters most: a consumer project
  // contains `node_modules/tsforge`, and so would have been treated as harness
  // development. A directory that merely sits above the harness is not working
  // on it either.
  const workingOnHarness = roots.some((root) => contains(root, workspace));

  return insideHarness && !workingOnHarness;
}

export function isForeignHarnessRead(cwd: string, file: string): boolean {
  return isForeignRead(harnessRoots(), cwd, file);
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
