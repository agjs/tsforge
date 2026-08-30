import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { isRecord } from "../lib/guards";

/** Manifest fields whose presence marks a package.json as a REAL package (its
 *  own code + deps to gate) rather than a scripts-only monorepo root shell. */
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** True when `cwd`'s package.json declares no dependencies of any kind — the
 *  scripts-only shell manifest a monorepo root keeps for `engines`/`scripts`
 *  (boringstack's shape). Unreadable/unparseable ⇒ NOT a shell (fail closed:
 *  treat it as a real package rather than re-scoping the gate on bad JSON). */
function isShellManifest(cwd: string): boolean {
  let raw: string;

  try {
    raw = readFileSync(join(cwd, "package.json"), "utf8");
  } catch {
    return false;
  }

  try {
    const pkg: unknown = JSON.parse(raw);

    if (!isRecord(pkg)) {
      return false;
    }

    return DEP_FIELDS.every((field) => {
      const deps = pkg[field];

      return (
        deps === undefined || (isRecord(deps) && Object.keys(deps).length === 0)
      );
    });
  } catch {
    return false;
  }
}

/**
 * A folder that contains other JS packages but is not itself a package to gate:
 * either no root package.json at all (a multi-repo workspace bag), or a
 * scripts-only shell manifest with the real packages nested below (a monorepo
 * root like `apps/api` + `apps/ui`). Gating such a root as ONE package breaks
 * everything downstream — a root tsconfig sweeping every .ts file across
 * packages that own their types/paths yields hundreds of phantom errors (observed:
 * a Bun monorepo red with 708 `bun:test`/`Bun`-not-found errors), so the
 * per-package container gate must engage instead.
 */
export function isWorkspaceContainer(cwd: string): boolean {
  if (existsSync(join(cwd, "package.json")) && !isShellManifest(cwd)) {
    return false;
  }

  return listChildPackageRoots(cwd).length > 0;
}

/** Package roots under `cwd`: immediate child directories with a package.json,
 *  plus — for child directories WITHOUT one (grouping dirs like `apps/`,
 *  `packages/`) — their immediate children that have one. Two levels covers the
 *  conventional monorepo layouts; a dir that IS a package is never descended
 *  into (its nested fixtures/examples belong to it, not the workspace). */
export function listChildPackageRoots(cwd: string): string[] {
  const out: string[] = [];

  for (const child of childDirs(cwd)) {
    if (existsSync(join(child, "package.json"))) {
      out.push(child);
      continue;
    }

    for (const grandchild of childDirs(child)) {
      if (existsSync(join(grandchild, "package.json"))) {
        out.push(grandchild);
      }
    }
  }

  return out.sort();
}

/** Absolute paths of `dir`'s child directories worth scanning for packages. */
function childDirs(dir: string): string[] {
  let entries: { name: string; isDirectory: () => boolean }[];

  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const out: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    out.push(join(dir, entry.name));
  }

  return out;
}

/** True when `abs` is `dir` itself or lives anywhere under it. */
function containsPath(dir: string, abs: string): boolean {
  const rel = relative(dir, abs);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Map session-relative (or absolute) touched paths to package roots under `cwd`.
 * Only immediate child packages are considered (workspace-container layout).
 */
export function activePackageRoots(
  cwd: string,
  touched: Iterable<string>
): string[] {
  const children = listChildPackageRoots(cwd);

  if (children.length === 0) {
    return [];
  }

  const found = new Set<string>();

  for (const path of touched) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    const owner = children.find((pkg) => containsPath(pkg, abs));

    if (owner !== undefined) {
      found.add(owner);
    }
  }

  return [...found].sort();
}

/** The package that owns `absPath`, or null when it belongs to none. */
export function owningPackageRoot(cwd: string, absPath: string): string | null {
  return (
    listChildPackageRoots(cwd).find((pkg) => containsPath(pkg, absPath)) ?? null
  );
}

/** Extensions the gate typechecks/lints — a package.json is required to do either. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Touched CODE files that live under no child package. Nothing can gate these
 * (no package.json ⇒ no tsconfig, no eslint root), so the container gate must
 * fail on them instead of reporting the vacuous green of "no package edited".
 * Non-code touches (docs, root config) are not listed — those are legitimately
 * ungated.
 */
export function unpackagedCodePaths(
  cwd: string,
  touched: Iterable<string>
): string[] {
  const children = listChildPackageRoots(cwd);
  const found = new Set<string>();

  for (const path of touched) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);

    if (!CODE_EXT.test(abs)) {
      continue;
    }

    if (!children.some((pkg) => containsPath(pkg, abs))) {
      found.add(relative(cwd, abs));
    }
  }

  return [...found].sort();
}

/** Short label for banners / gate output (directory basename). */
export function packageLabel(pkgAbs: string): string {
  return basename(pkgAbs);
}
