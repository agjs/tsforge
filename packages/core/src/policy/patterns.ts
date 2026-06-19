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

/** The head command of one shell segment, with env-assignments, `sudo`, and any
 *  directory prefix removed (`/bin/rm` → `rm`, `sudo rm` → `rm`). */
function commandHead(segment: string): string {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let i = 0;

  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "") || tokens[i] === "sudo")
  ) {
    i += 1;
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
