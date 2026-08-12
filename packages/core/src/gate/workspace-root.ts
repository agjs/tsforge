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

    for (const pkg of children) {
      const rel = relative(pkg, abs);

      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        found.add(pkg);
        break;
      }
    }
  }

  return [...found].sort();
}

/** Short label for banners / gate output (directory basename). */
export function packageLabel(pkgAbs: string): string {
  return basename(pkgAbs);
}
