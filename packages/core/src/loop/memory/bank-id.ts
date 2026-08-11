import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a stable per-project bank id for decision memory.
 * Order: explicit override → git origin → path hash of project root.
 * Not read from `.tsforge/` — computed each session.
 */

export interface IBankIdDeps {
  /** Override from config `providers.memory.bankId`. */
  readonly configuredBankId?: string;
  /** Run a git command in `cwd`; return stdout or null on failure. */
  readonly gitRemoteUrl: (cwd: string) => Promise<string | null>;
  /** True if `path` exists as a file or directory. */
  readonly exists: (path: string) => Promise<boolean>;
}

function normalizeRemote(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // git@host:owner/repo.git
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/iu.exec(trimmed);

  if (scp !== null) {
    const host = scp[1]?.toLowerCase();
    const path = scp[2]?.replace(/\.git$/iu, "");

    if (host !== undefined && path !== undefined && path.length > 0) {
      return `tsforge:${host}/${path}`;
    }
  }

  // https://host/owner/repo.git (or ssh://)
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\//u, "").replace(/\.git$/iu, "");

    if (host.length > 0 && path.length > 0) {
      return `tsforge:${host}/${path}`;
    }
  } catch {
    return null;
  }

  return null;
}

/** Walk up from `startDir` to find a directory that owns `.git` or `tsforge.config.json`. */
export async function findProjectRoot(
  startDir: string,
  exists: (path: string) => Promise<boolean>
): Promise<string> {
  let dir = startDir;

  for (;;) {
    if (
      (await exists(join(dir, ".git"))) ||
      (await exists(join(dir, "tsforge.config.json")))
    ) {
      return dir;
    }

    const parent = join(dir, "..");

    if (parent === dir) {
      return startDir;
    }

    dir = parent;
  }
}

function pathBankId(projectRoot: string): string {
  let resolved = projectRoot;

  try {
    resolved = realpathSync(projectRoot);
  } catch {
    // keep projectRoot
  }

  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 32);

  return `tsforge:path:${hash}`;
}

export async function resolveBankId(
  cwd: string,
  deps: IBankIdDeps
): Promise<string> {
  const configured = deps.configuredBankId?.trim();

  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  const projectRoot = await findProjectRoot(cwd, deps.exists);
  const remote = await deps.gitRemoteUrl(projectRoot);

  if (remote !== null) {
    const normalized = normalizeRemote(remote);

    if (normalized !== null) {
      return normalized;
    }
  }

  return pathBankId(projectRoot);
}
