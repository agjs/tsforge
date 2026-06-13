import type { ILoopEvent } from "../loop/loop.types";
import { isRecord } from "../lib/guards";

/** The known event kinds, as a runtime set, so a JSONL line can be validated
 *  into a typed ILoopEvent without an `as` cast. Keep in sync with ILoopEvent. */
const KNOWN_KINDS = new Set<string>([
  "start",
  "red",
  "cycle",
  "token",
  "message",
  "fix",
  "edit",
  "create",
  "validated",
  "done",
  "stuck",
  "run",
  "tool",
  "repair",
  "timing",
  "usage",
  "ttsr",
]);

function isKind(value: string): value is ILoopEvent["kind"] {
  return KNOWN_KINDS.has(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((v): v is string => typeof v === "string");
}

/** Coerce one parsed JSONL record into an ILoopEvent, or null when it isn't one.
 *  Reads only the fields the failure classifier + metrics consume — enough to
 *  reconstruct a typed event stream from a `--log` file. */
function coerceEvent(record: unknown): ILoopEvent | null {
  if (!isRecord(record)) {
    return null;
  }

  const kind = record.kind;

  if (typeof kind !== "string" || !isKind(kind)) {
    return null;
  }

  const event: ILoopEvent = {
    kind,
    task: optionalString(record.task) ?? "",
    message: optionalString(record.message) ?? "",
  };
  const output = optionalString(record.output);
  const rules = stringArray(record.rules);

  if (output !== undefined) {
    event.output = output;
  }

  if (typeof record.passed === "boolean") {
    event.passed = record.passed;
  }

  if (rules !== undefined) {
    event.rules = rules;
  }

  return event;
}

/** Parse a `--log` JSONL transcript (one serialized event per line) into a typed
 *  event stream. Malformed lines and non-event records are skipped. */
export function parseEventLog(jsonl: string): ILoopEvent[] {
  const events: ILoopEvent[] = [];

  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = coerceEvent(parsed);

    if (event !== null) {
      events.push(event);
    }
  }

  return events;
}
