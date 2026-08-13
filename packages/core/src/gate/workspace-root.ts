import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { readdirSync, existsSync } from "node:fs";

/**
 * A folder that contains other JS packages but is not itself a package
 * (no root package.json). Example: a multi-repo workspace root.
 */
export function isWorkspaceContainer(cwd: string): boolean {
  if (existsSync(join(cwd, "package.json"))) {
    return false;
  }

  return listChildPackageRoots(cwd).length > 0;
}

/** Absolute paths of immediate child directories that have a package.json. */
export function listChildPackageRoots(cwd: string): string[] {
  let entries: { name: string; isDirectory: () => boolean }[];

  try {
    entries = readdirSync(cwd, { withFileTypes: true, encoding: "utf8" });
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

    const child = join(cwd, entry.name);

    if (existsSync(join(child, "package.json"))) {
      out.push(child);
    }
  }

  return out.sort();
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
