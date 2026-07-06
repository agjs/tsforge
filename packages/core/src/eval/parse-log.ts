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
  "reverted",
  "policy",
  "agent_spawned",
  "agent_started",
  "agent_result",
]);

function isKind(value: string): value is ILoopEvent["kind"] {
  return KNOWN_KINDS.has(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((v): v is string => typeof v === "string");
}

function toDecision(value: unknown): ILoopEvent["decision"] {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : undefined;
}

function toRisk(value: unknown): ILoopEvent["risk"] {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
    ? value
    : undefined;
}

/** The event's field source. The `--log` ledger wraps every event in `payload`
 *  ({type, payload:{kind,…}}); a legacy/raw stream IS the event ({kind,…}). Read
 *  through whichever shape this line is, so both parse identically. A wrapped
 *  ledger line never has a top-level `kind` (it lives in `payload`), so gating on
 *  its ABSENCE keeps a legacy flat event that happens to carry its own `payload`
 *  field (e.g. tool args) from being misread as wrapped. */
function eventSource(record: unknown): Record<string, unknown> | null {
  if (!isRecord(record)) {
    return null;
  }

  return !("kind" in record) && isRecord(record.payload)
    ? record.payload
    : record;
}

function assignText(event: ILoopEvent, src: Record<string, unknown>): void {
  const output = optionalString(src.output);
  const file = optionalString(src.file);
  const model = optionalString(src.model);
  const detail = optionalString(src.detail);

  if (output !== undefined) {
    event.output = output;
  }

  if (file !== undefined) {
    event.file = file;
  }

  if (model !== undefined) {
    event.model = model;
  }

  if (detail !== undefined) {
    event.detail = detail;
  }
}

function assignNumbers(event: ILoopEvent, src: Record<string, unknown>): void {
  const count = optionalNumber(src.count);
  const ms = optionalNumber(src.ms);

  if (count !== undefined) {
    event.count = count;
  }

  const promptTokens = optionalNumber(src.promptTokens);
  const completionTokens = optionalNumber(src.completionTokens);
  const totalTokens = optionalNumber(src.totalTokens);
  const tokensPerSecond = optionalNumber(src.tokensPerSecond);
  const contextWindow = optionalNumber(src.contextWindow);

  if (ms !== undefined) {
    event.ms = ms;
  }

  if (promptTokens !== undefined) {
    event.promptTokens = promptTokens;
  }

  if (completionTokens !== undefined) {
    event.completionTokens = completionTokens;
  }

  if (totalTokens !== undefined) {
    event.totalTokens = totalTokens;
  }

  if (tokensPerSecond !== undefined) {
    event.tokensPerSecond = tokensPerSecond;
  }

  if (contextWindow !== undefined) {
    event.contextWindow = contextWindow;
  }
}

function assignVerdict(event: ILoopEvent, src: Record<string, unknown>): void {
  const decision = toDecision(src.decision);
  const risk = toRisk(src.risk);
  const rules = stringArray(src.rules);

  if (decision !== undefined) {
    event.decision = decision;
  }

  if (risk !== undefined) {
    event.risk = risk;
  }

  if (typeof src.passed === "boolean") {
    event.passed = src.passed;
  }

  if (rules !== undefined) {
    event.rules = rules;
  }
}

/** Re-attach agent attribution. `parentTask` rides inside the payload, but the
 *  ledger writer lifts `agentId` OUT of the payload into a top-level column —
 *  so read it from the source first (flat/legacy shape) and fall back to the
 *  outer record (wrapped ledger shape). */
function assignAgent(
  event: ILoopEvent,
  src: Record<string, unknown>,
  record: unknown
): void {
  const outer = isRecord(record) ? optionalString(record.agentId) : undefined;
  const agentId = optionalString(src.agentId) ?? outer;
  const parentTask = optionalString(src.parentTask);

  if (agentId !== undefined) {
    event.agentId = agentId;
  }

  if (parentTask !== undefined) {
    event.parentTask = parentTask;
  }
}

/** Coerce one parsed JSONL record into an ILoopEvent, or null when it isn't one.
 *  Carries the fields the failure classifier, the metrics, and the trace summary
 *  consume — enough to reconstruct a typed event stream from a `--log` file. */
function coerceEvent(record: unknown): ILoopEvent | null {
  const src = eventSource(record);

  if (src === null) {
    return null;
  }

  const kind = src.kind;

  if (typeof kind !== "string" || !isKind(kind)) {
    return null;
  }

  const event: ILoopEvent = {
    kind,
    task: optionalString(src.task) ?? "",
    message: optionalString(src.message) ?? "",
  };

  assignText(event, src);
  assignNumbers(event, src);
  assignVerdict(event, src);
  assignAgent(event, src, record);

  return event;
}

/** Parse a `--log` JSONL transcript (one serialized event per line) into a typed
 *  event stream. Malformed lines and non-event records are skipped. Tolerates
 *  both the ledger shape ({type, payload:{kind,…}}) and the flat shape ({kind,…}). */
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
