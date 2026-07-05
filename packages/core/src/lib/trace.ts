import { appendFileSync } from "node:fs";

/**
 * Env-gated diagnostic trace for silent degrade paths. Production stays silent;
 * `TSFORGE_TRACE=1 tsforge …` (or `TSFORGE_DEBUG`) surfaces what quietly degraded.
 *
 * When the env var is set, emit `"[scope] <message>"` (plus the stack for Errors):
 * to a FILE when the value looks like a path, else to stderr (`"1"`/`"true"`/
 * `"stderr"`). Unset ⇒ no-op. Never throws — a failed trace write is not worth
 * crashing a degrade path over, so it falls back to stderr.
 */
export function trace(scope: string, err: unknown): void {
  const target = process.env.TSFORGE_TRACE ?? process.env.TSFORGE_DEBUG;

  if (target === undefined || target.length === 0) {
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error && err.stack !== undefined ? `\n${err.stack}` : "";
  const line = `[${scope}] ${message}${stack}\n`;

  if (target === "1" || target === "true" || target === "stderr") {
    process.stderr.write(line);

    return;
  }

  try {
    appendFileSync(target, line);
  } catch {
    process.stderr.write(line);
  }
}
