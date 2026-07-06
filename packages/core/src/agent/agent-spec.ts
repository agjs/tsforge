/**
 * A declarative subagent definition — data-only, like recipes. Describes WHAT
 * an agent is (model, persona, tool subset, caps); the AgentRunner decides how
 * it executes. Loaded from `.tsforge/agents/*.json` (see config/agent-specs).
 */

export type AgentKind = "chat" | "generate";
export type AgentOutputMode = "text" | "structured";

export interface IAgentSpec {
  /** Stable kebab-case id (`explore`, `verify-claim`). */
  readonly id: string;
  /** One-line summary shown by listings. */
  readonly description?: string;
  /** Model name from `~/.tsforge/models.json`; absent ⇒ the session's model. */
  readonly model?: string;
  /** `"chat"` (tool-loop agent, default). `"generate"` is the reserved seam for
   *  non-chat specialists (image gen) — Phase D; the runner rejects it today. */
  readonly kind?: AgentKind;
  /** System-prompt override; absent ⇒ the runner's read-only explorer prompt. */
  readonly systemPrompt?: string;
  /** Tool subset the agent may use (names from TOOL_NAME). Always intersected
   *  with the read-only tool set — a spec cannot grant mutation. */
  readonly tools?: readonly string[];
  /** Default task/prompt when the caller doesn't supply one. */
  readonly task?: string;
  /** Hard cap on model turns (default AGENT_LIMITS.maxTurns). */
  readonly maxTurns?: number;
  /** `"structured"` forces a final `agent_result` tool call so the parent gets
   *  a parseable payload; `"text"` (default) returns the final message. */
  readonly outputMode?: AgentOutputMode;
}
