import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ILoopEvent } from "../loop";
import { isRecord } from "../lib/guards";
import type { IMinedRun } from "./mine";

/**
 * Turn REAL build logs into mining evidence.
 *
 * The acceptance rule needs repeatable tasks — you cannot measure a delta
 * against a build that happens once — so the fixed corpus stays the measuring
 * instrument. But nothing says the EVIDENCE has to come from the same place.
 * A corpus that the model passes 8/8 has nothing left to teach it, while the
 * real work it does every day is full of failures worth mining.
 *
 * So: real builds say what is going wrong, the corpus decides whether a
 * proposed fix actually helps. The paper's rigor is in the second half, and
 * this leaves it untouched.
 */

/** A build's slow-green threshold. Real builds run far longer than corpus
 *  tasks, so a green one is only worth mining when it took much longer than a
 *  build of that kind should. */
export const BUILD_SLOW_THRESHOLD = 40;

/**
 * Parse one JSONL run log into the events mining reads.
 *
 * Two writers produce these logs: a flat one (`{kind, message, …}`) and the
 * typed ledger, which nests the real fields under `payload` and names the
 * discriminant `type`. Reading only the flat shape would silently mine nothing
 * from half the logs — the same class of quiet-wrong-answer this whole session
 * has been about.
 *
 * The event is rebuilt field by field rather than asserted, so what mining sees
 * is only what was actually present. Malformed lines are skipped: a log
 * truncated by a crash is still evidence, and the crash is often the thing
 * worth mining.
 */
export function parseEventLog(text: string): ILoopEvent[] {
  const events: ILoopEvent[] = [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    const event = parseEventLine(line);

    if (event !== null) {
      events.push(event);
    }
  }

  return events;
}

function parseEventLine(line: string): ILoopEvent | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  // The typed ledger writes `{type, payload:{…}}`; payload wins, since it holds
  // the event's real fields.
  const rec: Record<string, unknown> = isRecord(parsed.payload)
    ? { ...parsed, ...parsed.payload }
    : parsed;
  const kind = typeof rec.kind === "string" ? rec.kind : rec.type;

  if (typeof kind !== "string" || !isEventKind(kind)) {
    return null;
  }

  return {
    kind,
    task: typeof rec.task === "string" ? rec.task : "session",
    message: typeof rec.message === "string" ? rec.message : "",
    ...(typeof rec.passed === "boolean" ? { passed: rec.passed } : {}),
    ...(isStringArray(rec.rules) ? { rules: rec.rules } : {}),
  };
}

/** The event kinds mining and the pass check actually read. Anything else is a
 *  token/timing/usage line that classification ignores, so dropping it costs
 *  nothing and keeps the reconstruction honest about what it knows. */
const MINED_KINDS = new Set([
  "cycle",
  "validated",
  "tool",
  "repair",
  "stuck",
  "done",
  "fix",
  "reverted",
  "edit",
  "create",
]);

function isEventKind(kind: string): kind is ILoopEvent["kind"] {
  return MINED_KINDS.has(kind);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Did this run end green?
 *
 * The LAST terminal event decides. A multi-task build emits `done` per task, so
 * counting `done` events would call a run green that finished its first task
 * and then got stuck on the second — exactly the run most worth mining.
 */
export function runPassed(events: readonly ILoopEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const kind = events[i]?.kind;

    if (kind === "done") {
      return true;
    }

    if (kind === "stuck") {
      return false;
    }
  }

  return false;
}

/** A log with no model turns never got started — an endpoint that was down, or
 *  a run killed on launch. Mining it would manufacture a failure pattern out of
 *  an infrastructure problem, which is the one thing the campaign's guards
 *  exist to prevent. */
function hasRealWork(events: readonly ILoopEvent[]): boolean {
  return events.some((e) => e.kind === "cycle");
}

export interface IBuildEvidenceOptions {
  /** Ignore logs older than this (ms since epoch). A campaign should mine what
   *  the CURRENT harness did, not what a harness three overlays ago did. */
  readonly since?: number;
  /** Cap on how many logs to read, newest first. */
  readonly limit?: number;
  readonly slowThreshold?: number;
}

/**
 * Read a directory of `*.jsonl` run logs as mining evidence, newest first.
 *
 * The task id is the log's filename, which is what the report will show as the
 * source of a mined pattern — so a human reading `report.md` can open the exact
 * run the proposer was reacting to.
 */
export async function buildEvidenceFrom(
  logsDir: string,
  opts: IBuildEvidenceOptions = {}
): Promise<IMinedRun[]> {
  let names: string[];

  try {
    names = (await readdir(logsDir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }

  // Filenames are timestamp-prefixed, so a lexical sort is newest-last.
  names.sort();
  names.reverse();

  const runs: IMinedRun[] = [];

  for (const name of names) {
    if (opts.limit !== undefined && runs.length >= opts.limit) {
      break;
    }

    const path = join(logsDir, name);
    const file = Bun.file(path);

    if (opts.since !== undefined && file.lastModified < opts.since) {
      continue;
    }

    const events = parseEventLog(await file.text());

    if (!hasRealWork(events)) {
      continue;
    }

    runs.push({
      taskId: basename(name, ".jsonl"),
      passed: runPassed(events),
      events,
      slowThreshold: opts.slowThreshold ?? BUILD_SLOW_THRESHOLD,
    });
  }

  return runs;
}
