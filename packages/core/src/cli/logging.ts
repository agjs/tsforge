/**
 * CLI-side reporting plumbing: the shared spinner, the terminal Reporter, the
 * `--log` JSONL ledger reporter, and run-log path helpers. The REPL routes
 * streamed output through the StatusBar via setInteractiveStream(); everywhere
 * else the reporter writes straight to stdout.
 */
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { makeSpinner, spinnerPhase } from "../render/spinner";
import { renderEvent } from "../render";
import { LedgerWriter, ledgerTypeFor, type Reporter } from "../loop";
import { logsDir } from "../session-store";
import { trace } from "../lib/trace";

export const spinner = makeSpinner();

/** When the interactive REPL pins an editable input row, streamed output must be
 *  written THROUGH the StatusBar (so it scrolls in the region above the row and
 *  the cursor stays parked on the row). Null elsewhere ⇒ a plain stdout write. */
let interactiveStream: ((text: string) => void) | null = null;

/** Install (or clear, with null) the REPL's streamed-output sink. */
export function setInteractiveStream(
  sink: ((text: string) => void) | null
): void {
  interactiveStream = sink;
}

const render: Reporter = (event) => {
  const phase = spinnerPhase(event);

  if (phase !== null) {
    spinner.setLabel(phase);
  }

  const out = renderEvent(event, { color: true });

  if (out.length > 0) {
    spinner.clear();

    if (interactiveStream !== null) {
      interactiveStream(out);
    } else {
      process.stdout.write(out);
    }
  }
};

/** Reporter that renders to the terminal AND, when `--log <file>` is set, appends
 *  the full event stream as JSONL (one event per line, timestamped) for later
 *  evaluation — the durable record of what the agent did: its reasoning, every
 *  file it wrote, the gate verdicts, and the loops it got stuck in. Append-only
 *  (NOT overwritten like the session JSON), and unredacted — it's an opt-in local
 *  debug artifact. Logging failures never break the session. */
export function makeReporter(
  logFile: string,
  runId: string,
  sessionId?: string
): Reporter {
  if (logFile.length === 0) {
    return render;
  }

  const ledger = new LedgerWriter(logFile, runId, sessionId);

  return (event) => {
    render(event);

    const { kind, ...rest } = event;

    ledger.record(ledgerTypeFor(event), { kind, ...rest });
  };
}

/** Resolve the run-log file when `--log` is set: an auto-named, timestamped JSONL
 *  under ~/.tsforge/logs/ (created if needed), so logs are always in one findable
 *  place and you never specify a path. Empty string = logging off. */
export function resolveLogPath(id: string, enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  const dir = logsDir();

  mkdirSync(dir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");

  return join(dir, `${stamp}-${id}.jsonl`);
}

/** Resolve the newest `--log` JSONL under ~/.tsforge/logs, or "" if none. */
export async function newestLogFile(): Promise<string> {
  try {
    // Filenames are ISO-timestamp-prefixed, so lexicographic sort = chronological.
    const names = (await readdir(logsDir()))
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    const latest = names.at(-1);

    return latest === undefined ? "" : join(logsDir(), latest);
  } catch (err) {
    trace("cli.newestLogFile", err);

    return "";
  }
}

/** A user-supplied log path resolved against cwd, or "" when none was given. */
export function resolveLogArg(arg: string): string {
  if (arg.length === 0) {
    return "";
  }

  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}
