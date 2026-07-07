/**
 * CLI-side reporting plumbing: the shared spinner, the terminal Reporter, the
 * `--log` JSONL ledger reporter, and run-log path helpers. Rendered output is
 * routed through the OutputRouter: the REPL installs a StatusBar-aware parent
 * sink (so text scrolls above the pinned input row); subagents get their own
 * sinks from Phase B on; everywhere else writes go straight to stdout.
 */
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { makeSpinner, spinnerPhase } from "../render/spinner";
import { renderEvent } from "../render";
import {
  LedgerWriter,
  ledgerTypeFor,
  type Reporter,
  type ILoopEvent,
} from "../loop";
import { logsDir } from "../session-store";
import { trace } from "../lib/trace";
import { OutputRouter } from "./output-router";

export const spinner = makeSpinner();

/** The process-wide router for the one terminal. The REPL installs its parent
 *  sink at boot and clears it on exit; agent sinks come and go per subagent. */
export const outputRouter = new OutputRouter();

/** A live observer of EVERY rendered event — the REPL registers one to drive the
 *  agent tree (folding `agent_*` lifecycle events and diverting subagent output).
 *  Module-level because `render` is the one choke point all events pass through;
 *  null when no REPL is attached (headless/one-shot). */
let eventObserver: ((event: ILoopEvent) => void) | null = null;

export function observeEvents(fn: ((event: ILoopEvent) => void) | null): void {
  eventObserver = fn;
}

const render: Reporter = (event) => {
  eventObserver?.(event);

  const phase = spinnerPhase(event);

  if (phase !== null) {
    spinner.setLabel(phase);
  }

  const out = renderEvent(event, { color: true });

  if (out.length > 0) {
    spinner.clear();
    outputRouter.route(out, event.agentId);
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

    const { kind, agentId, ...rest } = event;

    ledger.record(ledgerTypeFor(event), { kind, ...rest }, agentId);
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
