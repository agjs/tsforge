import { appendFileSync } from "node:fs";
import { redactText } from "../session-store";
import type { ILoopEvent } from "./loop.types";
import type { IBaseLedgerEvent, LedgerEventType } from "./ledger.types";

/**
 * Map a reporter event to its typed ledger event type. Most boundaries are
 * derived from existing kinds (a turn ≈ one model call); events without a
 * dedicated type fall through to `"log"`. `tool_call_requested`/`started`,
 * `gate_started`, `resume_*`, and `user_prompt` are deferred (no signal yet).
 */
export function ledgerTypeFor(event: ILoopEvent): LedgerEventType {
  switch (event.kind) {
    case "start":
      return "run_started";
    case "done":
    case "stuck":
      return "run_finished";
    case "cycle":
      return "model_call_started";
    case "usage":
      return "model_call_finished";
    case "validated":
      return "gate_finished";
    case "edit":
    case "create":
    case "run":
      return "tool_call_finished";
    case "reverted":
      return "edit_reverted";
    case "policy":
      return "policy_decision";
    case "inject":
      return "model_inject";
    case "agent_spawned":
      return "agent_spawned";
    case "agent_started":
      return "agent_started";
    case "agent_result":
      return "agent_result";
    case "tool":
      return event.message.startsWith("tool_rejected")
        ? "tool_call_failed"
        : "log";
    default:
      return "log";
  }
}

/** Per-string payload cap — previews, not full file dumps or command output. */
const MAX_VALUE_CHARS = 4096;

/** Wider cap for `model_inject`: its whole point is the FULL text the model was
 *  shown, and a settle wall (errors + rule help + pushed guides) regularly
 *  passes 4KB. Still bounded so a pathological inject can't bloat the ledger. */
const MAX_INJECT_CHARS = 32_768;

function newEventId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Redact secrets and truncate an over-long string to a capped preview. */
function capString(value: string, maxChars: number = MAX_VALUE_CHARS): string {
  const redacted = redactText(value);

  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars)}…[+${redacted.length - maxChars} chars]`
    : redacted;
}

/** Redact + cap every value in a payload (one level into arrays/objects). */
function capValue(value: unknown, maxChars?: number): unknown {
  if (typeof value === "string") {
    return capString(value, maxChars);
  }

  if (Array.isArray(value)) {
    return value.map((v) => capValue(v, maxChars));
  }

  if (value !== null && typeof value === "object") {
    // Only recurse into PLAIN objects: Object.entries() returns [] for Date /
    // RegExp / Map / class instances, which would silently flatten them to `{}`.
    // Pass those through so JSON.stringify uses their own serialization (e.g.
    // Date → ISO string via toJSON).
    const proto: unknown = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null
      ? capPayload(value, maxChars)
      : value;
  }

  return value;
}

function capPayload(
  payload: object,
  maxChars?: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    out[key] = capValue(value, maxChars);
  }

  return out;
}

/**
 * Append-only typed run ledger. Writes are synchronous (`appendFileSync`), so
 * lines never interleave and the file is always valid JSONL. Every payload is
 * secret-redacted and size-capped first; a write failure is swallowed so the
 * ledger can never break the run. A no-op when no log file is configured.
 */
export class LedgerWriter {
  constructor(
    private readonly file: string,
    private readonly runId: string,
    private readonly sessionId?: string
  ) {}

  record(
    type: LedgerEventType,
    payload: Record<string, unknown>,
    agentId?: string
  ): void {
    if (this.file.length === 0) {
      return;
    }

    const event: IBaseLedgerEvent = {
      eventId: newEventId(),
      runId: this.runId,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(agentId === undefined ? {} : { agentId }),
      timestamp: new Date().toISOString(),
      type,
      payload: capPayload(
        payload,
        type === "model_inject" ? MAX_INJECT_CHARS : undefined
      ),
    };

    try {
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    } catch {
      // A logging failure must never interrupt the session.
    }
  }
}
