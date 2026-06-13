import { join } from "node:path";
import { statSync } from "node:fs";

export type PackageManagerId = "npm" | "yarn" | "pnpm" | "bun";

export interface ILockfileInfo {
  readonly manager: PackageManagerId;
  readonly filename: string;
}

export const LOCKFILES: readonly ILockfileInfo[] = [
  { manager: "npm", filename: "package-lock.json" },
  { manager: "yarn", filename: "yarn.lock" },
  { manager: "pnpm", filename: "pnpm-lock.yaml" },
  { manager: "bun", filename: "bun.lockb" },
  { manager: "bun", filename: "bun.lock" },
];

const MANAGER_LOCKFILES: Readonly<Record<PackageManagerId, readonly string[]>> =
  {
    npm: ["package-lock.json"],
    yarn: ["yarn.lock"],
    pnpm: ["pnpm-lock.yaml"],
    bun: ["bun.lockb", "bun.lock"],
  };

function fileExists(root: string, filename: string): boolean {
  try {
    return statSync(join(root, filename)).isFile();
  } catch {
    return false;
  }
}

/** Lockfiles present at the project root. */
export function detectPresentLockfiles(root: string): ILockfileInfo[] {
  const present: ILockfileInfo[] = [];

  for (const lockfile of LOCKFILES) {
    if (fileExists(root, lockfile.filename)) {
      present.push(lockfile);
    }
  }

  return present;
}

/** Parse `packageManager` field (e.g. bun@1.3.14) into a manager id. */
export function parsePackageManagerField(
  packageJson: Record<string, unknown> | null
): PackageManagerId | null {
  if (packageJson === null) {
    return null;
  }

  const value = packageJson.packageManager;

  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const manager = value.split("@")[0]?.trim();

  if (
    manager === "npm" ||
    manager === "yarn" ||
    manager === "pnpm" ||
    manager === "bun"
  ) {
    return manager;
  }

  return null;
}

/** Resolve the canonical package manager for lockfile checks. */
export function resolvePackageManager(
  root: string,
  packageJson: Record<string, unknown> | null
): PackageManagerId | null {
  const fromField = parsePackageManagerField(packageJson);

  if (fromField !== null) {
    return fromField;
  }

  const present = detectPresentLockfiles(root);
  const managers = new Set(present.map((entry) => entry.manager));

  if (managers.size === 1) {
    return [...managers][0] ?? null;
  }

  return null;
}

/** Whether the root has a lockfile for the given package manager. */
export function hasLockfileForManager(
  root: string,
  manager: PackageManagerId
): boolean {
  return MANAGER_LOCKFILES[manager].some((filename) =>
    fileExists(root, filename)
  );
}
