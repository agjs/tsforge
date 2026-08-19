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
 *  which is exactly where foreign clones / harness trees can sit.
 *  Do NOT list `/tmp` here — Linux `os.tmpdir()` is `/tmp/...`, and allowing it
 *  would let `rg` of a foreign tree under `/tmp` slip through confinement. Scratch
 *  writes under tmp are handled separately in `outsideWorkspacePaths`. */
const SYSTEM_PREFIXES: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/opt/local",
  "/dev",
  "/etc",
  "/System",
  "/Library",
  "/nix",
  "/Applications",
];

/** Scratch dirs where shell *redirects* are fine (`echo x > /tmp/out`) but
 *  reading/grepping a foreign tree is not. */
const TMP_PREFIXES: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/tmp",
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

/** True when `absPath` sits under a OS temp scratch prefix. */
export function isTmpScratchPath(absPath: string): boolean {
  const target = resolve(absPath);

  return TMP_PREFIXES.some(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`)
  );
}

/** True for OS/tooling paths that are fine outside the project (bins, …). */
export function isAllowedSystemPath(absPath: string): boolean {
  const target = resolve(absPath);

  if (isWin32()) {
    // Keep Windows simple: drive-root system dirs are uncommon in our shell recipes;
    // still allow Temp-style paths via prefix match on normalized form.
    const lower = target.toLowerCase();

    return (
      lower.includes("\\windows\\") ||
      lower.includes("\\program files") ||
      lower.startsWith("c:\\windows") ||
      lower.includes("\\temp\\") ||
      lower.endsWith("\\temp")
    );
  }

  return SYSTEM_PREFIXES.some(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`)
  );
}

/**
 * True when `token` is only used as a shell redirect destination in `segment`
 * (`>`, `>>`, `2>`, `&>`, …) — not as a read/search argument.
 */
export function isShellRedirectTarget(segment: string, token: string): boolean {
  const idx = segment.indexOf(token);

  if (idx < 0) {
    return false;
  }

  const before = segment.slice(0, idx).trimEnd();

  return /(?:&>>?|[0-9]*>>?|&>)$/u.test(before);
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

  // A `..` component ANYWHERE (not just at the start) escapes cwd —
  // `./../x`, `src/../../foreign/x`. The old start-anchored check missed these.
  if (/(?:^|\/)\.\.(?:\/|$)/u.test(token)) {
    return true;
  }

  return token.includes("/");
}

/** A path token carrying an UNEXPANDED home/var reference the shell will expand
 *  at runtime but confinement can't resolve — `$HOME/x`, `${HOME}/x`, `$FOO/x`.
 *  Treated as an offender (fail closed): the resolved target is unknowable, and
 *  `$HOME/.aws/credentials` must not pass as an under-cwd relative token. A
 *  scheme-leading URL (`https://…/$id`) does not start with `$`, so it is safe. */
function hasUnresolvableVar(token: string): boolean {
  return /(?:^\$|\$HOME\b|\$\{)/u.test(token) && token.includes("/");
}

/** One shell WORD produced by the quote-aware tokenizer. `quoted` marks a word
 *  whose payload came from inside quotes — expression commands (sed/awk/…) get
 *  their quoted args (regexes, addresses) skipped, since those are patterns,
 *  not paths, and look absolute (`'/foo/,/bar/p'`). */
interface IShellWord {
  text: string;
  quoted: boolean;
}

/** Split a shell segment into WORDS, honoring quotes: whitespace inside quotes
 *  does not break a word, and surrounding quotes are stripped. Adjacent
 *  quoted/unquoted runs join into one word (`-i` + `'s/a/b/'` stay separate
 *  words, but `a'b'c` is one). A word is `quoted` when ANY of its payload came
 *  from inside quotes. */
function shellWords(segment: string): IShellWord[] {
  const words: IShellWord[] = [];
  let cur = "";
  let curQuoted = false;
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      words.push({ text: cur, quoted: curQuoted });
    }

    cur = "";
    curQuoted = false;
    started = false;
  };

  for (const ch of segment) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }

      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      curQuoted = true;
      started = true;

      continue;
    }

    if (/\s/u.test(ch)) {
      flush();

      continue;
    }

    cur += ch;
    started = true;
  }

  flush();

  return words;
}

/** Regex/expression metacharacters. A quoted arg to an expression command
 *  (sed/awk/grep/…) containing any of these is a PATTERN or script, not a path
 *  (`'/^import/d'`, `'/re/,/re/p'`, `'^(a|b)'`) — skipped so it doesn't read as
 *  an absolute path. A CLEAN quoted path (`rg foo "/abs/tree"`) has none of
 *  these and is still scanned, so foreign-tree access stays blocked. */
const REGEX_METACHAR = /[\^$*+?()[\]{},|]/u;

/** Command heads whose QUOTED, regex-shaped arguments are expressions, not
 *  paths. Their unquoted args and clean quoted paths are still scanned, so
 *  `sed -i s/a/b/ /foreign/x` and `rg foo "/foreign"` both still trip. */
const EXPRESSION_COMMANDS = new Set([
  "sed",
  "awk",
  "gawk",
  "mawk",
  "perl",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "jq",
]);

/** The command head of a segment (skipping leading `VAR=val` assignments), by
 *  basename so `/usr/bin/sed` counts as `sed`. */
function commandHead(segment: string): string {
  const words = shellWords(segment.replace(/^(?:[A-Za-z_]\w*=\S*\s+)*/u, ""));
  const first = words[0]?.text ?? "";

  return first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
}

/**
 * Pull path-like tokens from a single shell SEGMENT, quote-aware. When the
 * segment's command is an expression tool (sed/awk/grep/…) its quoted words are
 * skipped (they are patterns/scripts, not paths — the sed/grep false-red);
 * unquoted words are always scanned. Best-effort — used to block foreign-tree
 * access, not as a full shell parser.
 */
export function extractPathTokens(command: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const skipQuoted = EXPRESSION_COMMANDS.has(commandHead(command));

  for (const word of shellWords(command)) {
    // Skip a quoted arg to an expression command ONLY when it is regex-shaped
    // (a pattern/script/address); a clean quoted PATH is still scanned.
    if (word.quoted && skipQuoted && REGEX_METACHAR.test(word.text)) {
      continue;
    }

    const token = word.text;

    if (token.length === 0 || seen.has(token)) {
      continue;
    }

    if (looksLikeFilesystemPath(token) || hasUnresolvableVar(token)) {
      seen.add(token);
      found.push(token);
    }
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

/** Split a command into segments on shell operators — quote-aware, so a
 *  delimiter INSIDE quotes (`sed 's|/a|/b|'`, `grep '^(x|y)'`) does NOT split a
 *  word mid-quote (the bug that turned a quoted regex into bare `/a`, `/b`
 *  offenders). Splits on `&&`/`||`/`;`/`|`/`&`/newline AND on command-
 *  substitution / subshell boundaries (`$(`, backtick, `(`, `)`) so an inner
 *  command surfaces (`echo $(cat /foreign/x)`), and so a data-only `echo …\n…`
 *  can't exempt a following real command. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  const two = (a: string): boolean => command.startsWith(a, i);

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (quote !== null) {
      cur += ch;

      if (ch === quote) {
        quote = null;
      }

      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i += 1;
      continue;
    }

    if (two("&&") || two("||")) {
      segments.push(cur);
      cur = "";
      i += 2;
      continue;
    }

    if (two("$(")) {
      segments.push(cur);
      cur = "";
      i += 2;
      continue;
    }

    if (";|&`()\n".includes(ch)) {
      segments.push(cur);
      cur = "";
      i += 1;
      continue;
    }

    cur += ch;
    i += 1;
  }

  segments.push(cur);

  return segments;
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
      if (!seen.has(token) && tokenEscapes(token, segment, roots, cwd)) {
        seen.add(token);
        offenders.push(token);
      }
    }
  }

  return offenders;
}

/** True when a path token in `segment` resolves outside every allowed root and
 *  is not an allowlisted system path or a legitimate scratch redirect. */
function tokenEscapes(
  token: string,
  segment: string,
  roots: readonly string[],
  cwd: string
): boolean {
  // An unexpanded `$HOME`/`$VAR` in a path resolves at runtime to somewhere
  // confinement can't know — fail closed rather than let it land under cwd as a
  // literal `$HOME/…` relative token.
  if (hasUnresolvableVar(token)) {
    return true;
  }

  const expanded = expandHome(token);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);

  if (isPathUnderRoots(roots, abs) || isAllowedSystemPath(abs)) {
    return false;
  }

  // Scratch redirects (`echo hi > /tmp/out`) are intentional; grepping a
  // foreign tree under /tmp is not (Linux CI tmpdir lives there).
  return !(isTmpScratchPath(abs) && isShellRedirectTarget(segment, token));
}

/** Re-check containment AFTER resolving symlinks — the lexical
 *  `resolveProjectPath` passes a workspace path that is (or traverses) a
 *  symlink pointing OUT of the tree, a read/search tunnel to any file. A
 *  MISSING target resolves to `true` (the caller's own read then fails
 *  cleanly, and a not-yet-created write target must not be pre-rejected).
 *  Mirrors image-tools' realpathWithinCwd, generalized to the root set. */
export async function realpathWithinRoots(
  roots: readonly string[],
  abs: string
): Promise<boolean> {
  const { realpath } = await import("node:fs/promises");
  const real = await realpath(abs).catch(() => null);

  if (real === null) {
    return true;
  }

  const realRoots = await Promise.all(
    roots.map((r) => realpath(r).catch(() => r))
  );

  return isPathUnderRoots(realRoots, real);
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
