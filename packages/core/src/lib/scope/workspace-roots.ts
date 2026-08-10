/**
 * Allowed filesystem roots for model `read` / path-bearing `run` / `search`.
 * Default: session cwd only. Optional extraRoots for intentional multi-repo work.
 * Absolute harness/tooling paths must never be implied — callers summarize those.
 */
import { isAbsolute, resolve, sep } from "node:path";
import { isWin32 } from "../platform";

/** Shared reject copy when the model tries to leave the project. */
export const OUTSIDE_PROJECT_REJECT =
  "path is outside the project workspace. Stay under the session directory. " +
  "Gate rule messages already say how to fix — do not inspect tsforge/harness source.";

/** OS prefixes the shell may reference without counting as "leaving the project".
 *  Keep this tight: `/var` alone would also match macOS `/var/folders` (tmpdir),
 *  which is exactly where foreign clones / harness trees can sit. */
const SYSTEM_PREFIXES: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/opt/local",
  "/tmp",
  "/var/tmp",
  "/dev",
  "/etc",
  "/System",
  "/Library",
  "/private/tmp",
  "/private/var/tmp",
  "/nix",
  "/Applications",
];

/** Resolve and normalize a root directory. */
export function normalizeRoot(root: string): string {
  return resolve(root);
}

/** True when `absPath` is `root` or a descendant (after resolve). */
export function isPathUnderRoot(root: string, absPath: string): boolean {
  const base = normalizeRoot(root);
  const target = resolve(absPath);

  if (target === base) {
    return true;
  }

  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;

  return target.startsWith(prefix);
}

/** True when `absPath` sits under any allowed project root. */
export function isPathUnderRoots(
  roots: readonly string[],
  absPath: string
): boolean {
  return roots.some((root) => isPathUnderRoot(root, absPath));
}

/** True for OS/tooling paths that are fine outside the project (bins, tmp, …). */
export function isAllowedSystemPath(absPath: string): boolean {
  const target = resolve(absPath);

  if (isWin32()) {
    // Keep Windows simple: drive-root system dirs are uncommon in our shell recipes;
    // still allow Temp-style paths via prefix match on normalized form.
    const lower = target.toLowerCase();

    return (
      lower.includes("\\windows\\") ||
      lower.includes("\\program files") ||
      lower.startsWith("c:\\windows")
    );
  }

  return SYSTEM_PREFIXES.some(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`)
  );
}

/** Build the effective root list: cwd first, then extra roots. */
export function allowedRoots(
  cwd: string,
  extraRoots: readonly string[] = []
): string[] {
  const roots = [normalizeRoot(cwd)];

  for (const extra of extraRoots) {
    const n = normalizeRoot(extra);

    if (!roots.includes(n)) {
      roots.push(n);
    }
  }

  return roots;
}

function looksLikeFilesystemPath(token: string): boolean {
  if (token.length === 0) {
    return false;
  }

  if (isAbsolute(token) || token.startsWith("./") || token.startsWith("../")) {
    return true;
  }

  // Home-relative
  if (token.startsWith("~/")) {
    return true;
  }

  return token.includes("/");
}

/**
 * Pull path-like tokens from a shell command (quoted + unquoted absolute / ../).
 * Best-effort — used to block foreign-tree greps, not as a full shell parser.
 */
export function extractPathTokens(command: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    const token = raw.trim();

    if (
      token.length === 0 ||
      !looksLikeFilesystemPath(token) ||
      seen.has(token)
    ) {
      return;
    }

    seen.add(token);
    found.push(token);
  };

  const quoted = /"([^"]+)"|'([^']+)'/gu;
  let match = quoted.exec(command);

  while (match !== null) {
    push(match[1] ?? match[2] ?? "");
    match = quoted.exec(command);
  }

  // Strip quoted regions so we don't double-count insides.
  const stripped = command.replace(/"[^"]*"|'[^']*'/gu, " ");

  const unquotedAbs = /(?:^|[\s=])(\/(?:[^\s;|&<>]+))/gu;

  match = unquotedAbs.exec(stripped);

  while (match !== null) {
    push(match[1] ?? "");
    match = unquotedAbs.exec(stripped);
  }

  const unquotedRel = /(?:^|[\s])(\.\.\/[^\s;|&<>]+)/gu;

  match = unquotedRel.exec(stripped);

  while (match !== null) {
    push(match[1] ?? "");
    match = unquotedRel.exec(stripped);
  }

  return found;
}

function expandHome(token: string): string {
  if (token.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;

    if (home !== undefined && home.length > 0) {
      return resolve(home, token.slice(2));
    }
  }

  return token;
}

/** Shell segments joined by `&&` / `||` / `;` / `|`. */
function shellSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|]/u);
}

/**
 * `printf` / `echo` only emit strings — absolute path *text* in their args is
 * not a filesystem escape (the condenser tests print abs paths on purpose).
 * Real accessors (`rg`, `cat`, …) in other segments are still scanned.
 */
function isDataOnlySegment(segment: string): boolean {
  const trimmed = segment.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)*/u, "");
  const first = trimmed.split(/\s+/u)[0] ?? "";
  const base = first.includes("/")
    ? first.slice(first.lastIndexOf("/") + 1)
    : first;

  return (
    base === "printf" || base === "echo" || base === "true" || base === "false"
  );
}

/**
 * Path tokens in `command` that resolve outside every allowed root and are not
 * allowlisted system paths. Empty ⇒ command is fine for confinement.
 */
export function outsideWorkspacePaths(
  cwd: string,
  command: string,
  extraRoots: readonly string[] = []
): string[] {
  const roots = allowedRoots(cwd, extraRoots);
  const offenders: string[] = [];
  const seen = new Set<string>();

  for (const segment of shellSegments(command)) {
    if (isDataOnlySegment(segment)) {
      continue;
    }

    for (const token of extractPathTokens(segment)) {
      if (seen.has(token)) {
        continue;
      }

      const expanded = expandHome(token);
      const abs = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(cwd, expanded);

      if (isPathUnderRoots(roots, abs) || isAllowedSystemPath(abs)) {
        continue;
      }

      seen.add(token);
      offenders.push(token);
    }
  }

  return offenders;
}

/**
 * Resolve a model-supplied file path against cwd/extraRoots.
 * Rejects escapes and absolute paths outside allowed roots.
 */
export function resolveProjectPath(
  cwd: string,
  file: string,
  extraRoots: readonly string[] = []
): { ok: true; abs: string } | { ok: false } {
  const expanded = expandHome(file);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const roots = allowedRoots(cwd, extraRoots);

  if (!isPathUnderRoots(roots, abs)) {
    return { ok: false };
  }

  return { ok: true, abs };
}
