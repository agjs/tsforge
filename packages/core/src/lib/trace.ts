import { appendFileSync } from "node:fs";
import { sep } from "node:path";

/** Values that DISABLE tracing (alongside unset/empty) — the natural "off"
 *  spellings a user would try. Without this, `TSFORGE_TRACE=0` fell through to
 *  the file branch and created a file literally named `0` in the workspace,
 *  appending diagnostics (which can carry secrets from failed provider/HTTP
 *  degrade paths) to it. */
const TRACE_OFF = new Set(["0", "false", "off", "no"]);

/** Values that route to STDERR rather than a file. */
const TRACE_STDERR = new Set(["1", "true", "stderr"]);

/**
 * Env-gated diagnostic trace for silent degrade paths. Production stays silent;
 * `TSFORGE_TRACE=1 tsforge …` (or `TSFORGE_DEBUG`) surfaces what quietly degraded.
 *
 * `1`/`true`/`stderr` → stderr. Unset/empty or a falsy sentinel
 * (`0`/`false`/`off`/`no`) → no-op. A value that looks like a PATH (contains a
 * separator, case-insensitively an absolute path) → appended to that file;
 * any OTHER bare word is treated as stderr, not a filename, so a typo can't
 * silently spew diagnostics into a workspace file. Never throws — a failed
 * trace write falls back to stderr.
 */
export function trace(scope: string, err: unknown): void {
  const target = process.env.TSFORGE_TRACE ?? process.env.TSFORGE_DEBUG;

  if (
    target === undefined ||
    target.length === 0 ||
    TRACE_OFF.has(target.toLowerCase())
  ) {
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error && err.stack !== undefined ? `\n${err.stack}` : "";
  const line = `[${scope}] ${message}${stack}\n`;

  // Only an explicit PATH is a file target; every other bare value → stderr.
  if (TRACE_STDERR.has(target) || !target.includes(sep)) {
    process.stderr.write(line);

    return;
  }

  try {
    appendFileSync(target, line);
  } catch {
    process.stderr.write(line);
  }
}
