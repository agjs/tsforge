/**
 * Typed run ledger: the `--log` stream as an append-only sequence of typed
 * events. Each line is one `IBaseLedgerEvent` (valid JSON), so a run is fully
 * reconstructable — model calls, tool calls, policy decisions, gate verdicts.
 */

export type LedgerEventType =
  | "run_started"
  | "run_finished"
  | "user_prompt"
  | "model_call_started"
  | "model_call_finished"
  | "tool_call_requested"
  | "tool_call_started"
  | "tool_call_finished"
  | "tool_call_failed"
  /** An applied edit batch was rolled back (gate-break or no quality gain). */
  | "edit_reverted"
  | "policy_decision"
  | "gate_started"
  | "gate_finished"
  | "resume_started"
  | "resume_finished"
  /** A subagent started under this run. */
  | "agent_spawned"
  /** A subagent finished (payload carries its status and output preview). */
  | "agent_result"
  /** Catch-all for reporter events without a dedicated ledger type yet. */
  | "log";

export interface IBaseLedgerEvent {
  /** Unique id for this event (for parentEventId references). */
  eventId: string;
  /** The run this event belongs to. */
  runId: string;
  /** The interactive session id, when applicable. */
  sessionId?: string;
  /** The subagent that emitted this event; absent = the parent/main loop. */
  agentId?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  type: LedgerEventType;
  /** The event that caused this one (e.g. the tool_call for its result). */
  parentEventId?: string;
  turnId?: string;
  attempt?: number;
  /** Event-specific data — redacted and size-capped before it is written. */
  payload: Record<string, unknown>;
}
