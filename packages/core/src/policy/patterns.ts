/**
 * Dangerous-pattern detectors used by the critical-deny set — the denials that
 * win in EVERY policy mode (including `bypassPermissions`). Kept tiny and
 * conservative on purpose: a false positive here blocks legitimate work.
 */

/** Command heads that destroy data regardless of flags. Matched against the
 *  resolved head of each shell segment (after `sudo`/`VAR=val` prefixes and any
 *  path prefix are stripped) — never a naive substring (so `npm` ≠ `mkfs`). */
const DESTRUCTIVE_HEADS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "dd",
  "mkfs",
  "shred",
  "wipefs",
  "fdisk",
  "parted",
  "cfdisk",
]);

/** Wrapper commands that prefix a REAL command — they (and their flags) must be
 *  skipped to reach the head being run (`sudo rm`, `env VAR=x rm`, `nohup rm`). */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
]);

/** Wrapper flags that consume the FOLLOWING token as their value, so it isn't
 *  mistaken for the head (`sudo -u root rm` → skip `-u root`). */
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-C",
  "-S",
  "-p",
  "--user",
  "--group",
]);

/** The head command of one shell segment, with env-assignments, wrapper commands
 *  (`sudo`/`env`/…) and their flags, and any directory prefix removed
 *  (`/bin/rm` → `rm`, `sudo -u root rm` → `rm`, `env VAR=x rm` → `rm`). */
function commandHead(segment: string): string {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i] ?? "";

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || COMMAND_WRAPPERS.has(token)) {
      i += 1; // env-assignment or a wrapper command
    } else if (token.startsWith("-")) {
      i += WRAPPER_VALUE_FLAGS.has(token) ? 2 : 1; // a wrapper flag (+ its value)
    } else {
      break; // the real head
    }
  }

  const head = tokens[i] ?? "";
  const slash = head.lastIndexOf("/");

  return slash >= 0 ? head.slice(slash + 1) : head;
}

/** True when ANY chained segment of the command invokes a destructive head.
 *  Splits on shell separators (`&&`, `||`, `|`, `;`, `&`, newline) so a
 *  `build && rm -rf /` can't smuggle the destructive part past the head check. */
export function isDestructiveShell(command: string): boolean {
  return command
    .split(/&&|\|\||[|;&\n]/)
    .some((segment) => DESTRUCTIVE_HEADS.has(commandHead(segment)));
}

/** Path shapes for unmistakable private-key / credential material. Deliberately
 *  EXCLUDES `.env` (commonly read for legitimate work) — this denies reads of
 *  actual key files only, in every mode. */
const PRIVATE_KEY_PATTERNS: readonly RegExp[] = [
  /(^|\/)id_rsa($|\.)/,
  /(^|\/)id_ed25519($|\.)/,
  /(^|\/)id_ecdsa($|\.)/,
  /(^|\/)id_dsa($|\.)/,
  /(^|\/)\.ssh\//,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
];

/** True when the (workspace-relative) path looks like private-key material. */
export function isPrivateKeyPath(path: string): boolean {
  return PRIVATE_KEY_PATTERNS.some((re) => re.test(path));
}
