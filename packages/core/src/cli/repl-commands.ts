/** Self-contained REPL commands shared with the CLI's one-shot modes:
 *  /sessions, /map, /review, /trace, and the /metrics turns-to-green line. */
import { buildAndPersistMap, mapStatus, forgetMap } from "../codebase";
import { reviewChange, formatReport } from "../loop";
import type { OpenAICompatibleProvider } from "../inference";
import { parseEventLog, formatTrace } from "../eval";
import { listSessions } from "../session-store";
import { newestLogFile, resolveLogArg } from "./logging";

/** The `/metrics` turns-to-green line (loop-efficiency: turns the last green run
 *  took). Extracted so the command switch stays a flat dispatch. */
export function turnsToGreenLine(turns: number | null): string {
  return turns === null
    ? "  turns to green: — (no green run yet)\n"
    : `  turns to green (last): ${String(turns)}\n`;
}

/** List saved sessions for a directory (the `/sessions` command). */
export async function printSessions(dir: string): Promise<void> {
  const sessions = await listSessions(dir);

  if (sessions.length === 0) {
    process.stdout.write("no saved sessions for this directory\n");

    return;
  }

  for (const s of sessions) {
    const firstUser = s.messages.find((m) => m.role === "user")?.content ?? "";
    const snippet = firstUser.slice(0, 48).replace(/\s+/g, " ");

    process.stdout.write(
      `  ${s.id}  ${String(s.messages.length).padStart(3)} msgs  ${snippet}\n`
    );
  }
}

/** `/map [status|forget]` (REPL) and `tsforge map` — build/inspect the workspace
 *  map. The built map primes future sessions (and a `/clear`). */
export async function runMapCommand(dir: string, sub: string): Promise<void> {
  if (sub === "status") {
    process.stdout.write(`${await mapStatus(dir)}\n`);

    return;
  }

  if (sub === "forget") {
    const had = await forgetMap(dir);

    process.stdout.write(
      had ? "workspace map deleted\n" : "no map to delete\n"
    );

    return;
  }

  if (sub.length > 0) {
    process.stdout.write(
      `unknown map subcommand: ${sub} (use 'status', 'forget', or nothing to build)\n`
    );

    return;
  }

  process.stdout.write("building workspace map…\n");

  try {
    const map = await buildAndPersistMap(dir);

    process.stdout.write(
      map === null
        ? "no tsconfig.json — nothing to map (the map is for TypeScript projects)\n"
        : `mapped ${map.meta.totalFiles} files, ${map.hubs.length} hubs. Primes new sessions (/clear to apply now).\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(`map failed: ${message}\n`);
  }
}

/** `/review` in the REPL — review the current change and print findings. */
export async function runReviewCommand(
  provider: OpenAICompatibleProvider,
  dir: string,
  base: string
): Promise<void> {
  process.stdout.write("reviewing the current change…\n");

  // Guard the REPL: a review error (git/fs/model) must not crash the session.
  try {
    const report = await reviewChange(provider, dir, {
      ...(base.length > 0 ? { base } : {}),
      log: (m) => process.stdout.write(`  ↳ ${m}\n`),
    });

    process.stdout.write(`\n${formatReport(report)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(`\nreview failed: ${message}\n`);
  }
}

/** `tsforge trace [logfile]` / `/trace` — summarize a `--log` run: model/tool
 *  calls, policy decisions (allow/ask/deny by risk), gate verdicts, and
 *  turns-to-green. Deterministic, no model call. With no path it prefers `prefer`
 *  (the live session log) and falls back to the newest log on disk. */
export async function runTraceCommand(
  arg: string,
  prefer = ""
): Promise<number> {
  let file = resolveLogArg(arg);

  if (file.length === 0) {
    file = prefer;
  }

  if (file.length === 0) {
    file = await newestLogFile();
  }

  if (file.length === 0) {
    process.stdout.write(
      "no log to analyze — run with --log first, or pass a path\n"
    );

    return 1;
  }

  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  const events = parseEventLog(text);

  if (events.length === 0) {
    process.stdout.write(`no events parsed from ${file}\n`);

    return 1;
  }

  process.stdout.write(`trace of ${file}\n\n${formatTrace(events)}\n`);

  return 0;
}
