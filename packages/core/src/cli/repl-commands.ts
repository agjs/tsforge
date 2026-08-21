/** Self-contained REPL commands shared with the CLI's one-shot modes:
 *  /sessions, /map, /review, /trace, and the /metrics turns-to-green line. */
import { buildAndPersistMap, mapStatus, forgetMap } from "../codebase";
import { review, formatReport, formatReviewCard, type Reporter } from "../loop";
import { STYLE, paint } from "../render";
import type { IProvider } from "../inference";
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

/**
 * List saved sessions to `out` (defaults to stdout).
 * Prefer {@link openSessionsMenu} in the REPL — raw stdout under PaneScreen
 * paints into the alt-screen and corrupts the input band.
 */
export async function printSessions(
  dir: string,
  out: (s: string) => void = (s) => {
    process.stdout.write(s);
  }
): Promise<void> {
  const sessions = await listSessions(dir);

  if (sessions.length === 0) {
    out("no saved sessions for this directory\n");

    return;
  }

  for (const s of sessions) {
    const firstUser = s.messages.find((m) => m.role === "user")?.content ?? "";
    const snippet = firstUser.slice(0, 48).replace(/\s+/g, " ");

    out(
      `  ${s.id}  ${String(s.messages.length).padStart(3)} msgs  ${snippet}\n`
    );
  }
}

/** `/map [status|forget]` (REPL) and `tsforge map` — build/inspect the workspace
 *  map. The built map primes future sessions (and a `/clear`). */
/** Default output sink. Under the pane TUI the caller MUST pass a pane-aware sink
 *  (the REPL's `echo`): raw `process.stdout.write` bypasses the compositor and
 *  corrupts the display (see printSessions). */
const STDOUT = (s: string): void => {
  process.stdout.write(s);
};

export async function runMapCommand(
  dir: string,
  sub: string,
  out: (s: string) => void = STDOUT
): Promise<void> {
  if (sub === "status") {
    out(`${await mapStatus(dir)}\n`);

    return;
  }

  if (sub === "forget") {
    const had = await forgetMap(dir);

    out(had ? "workspace map deleted\n" : "no map to delete\n");

    return;
  }

  if (sub.length > 0) {
    out(
      `unknown map subcommand: ${sub} (use 'status', 'forget', or nothing to build)\n`
    );

    return;
  }

  out("building workspace map…\n");

  try {
    const map = await buildAndPersistMap(dir);

    out(
      map === null
        ? "no tsconfig.json — nothing to map (the map is for TypeScript projects)\n"
        : `mapped ${map.meta.totalFiles} files, ${map.hubs.length} hubs. Primes new sessions (/clear to apply now).\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    out(`map failed: ${message}\n`);
  }
}

/** `/review` in the REPL — review the current change and print findings. `out` is
 *  the pane-aware sink; when `columns` is given the findings render as a colored,
 *  width-wrapped card (the TUI), otherwise plain text (CLI/pipe). Returns the PLAIN
 *  findings text (empty when clean/errored) so the caller can hand it to `/reviewfix`. */
export async function runReviewCommand(
  provider: IProvider,
  dir: string,
  base: string,
  out: (s: string) => void = STDOUT,
  columns?: number,
  reviewProviders: readonly IProvider[] = [],
  onEvent?: Reporter,
  concurrency?: number
): Promise<string> {
  out(
    `${paint("reviewing the current change…", STYLE.dim, columns !== undefined)}\n`
  );

  // Guard the REPL: a review error (git/fs/model) must not crash the session.
  try {
    const report = await review(provider, dir, {
      ...(base.length > 0 ? { base } : {}),
      ...(reviewProviders.length > 0 ? { reviewProviders } : {}),
      // Stream the fan-out into the live agent tree (visible progress).
      ...(onEvent === undefined ? {} : { onEvent }),
      ...(concurrency === undefined ? {} : { concurrency }),
      log: (m) => {
        out(`  ↳ ${m}\n`);
      },
    });

    const rendered =
      columns === undefined
        ? formatReport(report)
        : formatReviewCard(report, columns, true);

    out(`\n${rendered}\n`);

    // Plain text (never the colored card) so /reviewfix hands the agent readable
    // findings, not ANSI. Empty when there's nothing to act on.
    return report.findings.length > 0 ? formatReport(report) : "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    out(`\nreview failed: ${message}\n`);

    return "";
  }
}

/** `tsforge trace [logfile]` / `/trace` — summarize a `--log` run: model/tool
 *  calls, policy decisions (allow/ask/deny by risk), gate verdicts, and
 *  turns-to-green. Deterministic, no model call. With no path it prefers `prefer`
 *  (the live session log) and falls back to the newest log on disk. */
export async function runTraceCommand(
  arg: string,
  prefer = "",
  out: (s: string) => void = STDOUT
): Promise<number> {
  let file = resolveLogArg(arg);

  if (file.length === 0) {
    file = prefer;
  }

  if (file.length === 0) {
    file = await newestLogFile();
  }

  if (file.length === 0) {
    out("no log to analyze — run with --log first, or pass a path\n");

    return 1;
  }

  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  const events = parseEventLog(text);

  if (events.length === 0) {
    out(`no events parsed from ${file}\n`);

    return 1;
  }

  out(`trace of ${file}\n\n${formatTrace(events)}\n`);

  return 0;
}
