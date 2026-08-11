/**
 * Pluggable PROJECT DECISION memory — product/architecture choices retained in
 * a user-hosted backend (HTTP or MCP). Separate from Phase 1 failure→fix TTSR.
 */

/** Supported provider kinds in tsforge.config.json `providers.memory`. */
export type MemoryProviderKind = "http" | "mcp";

/** HTTP backend config (Hindsight-compatible retain/recall API shape). */
export interface IHttpMemoryProviderConfig {
  readonly kind: "http";
  readonly baseUrl: string;
  /** Override bank id; otherwise resolved from git remote or project path. */
  readonly bankId?: string;
}

/** MCP backend: map retain/recall/forget onto tools on a named mcpServers entry. */
export interface IMcpMemoryProviderConfig {
  readonly kind: "mcp";
  readonly server: string;
  readonly retainTool?: string;
  readonly recallTool?: string;
  readonly forgetTool?: string;
  readonly listTool?: string;
  readonly bankId?: string;
}

export type IMemoryProviderConfig =
  | IHttpMemoryProviderConfig
  | IMcpMemoryProviderConfig;

/** Runtime provider: fail-soft (never throws into the session loop). */
export interface IMemoryProvider {
  readonly bankId: string;
  recall(query: string): Promise<string | null>;
  retain(content: string): Promise<void>;
  list(): Promise<readonly string[]>;
  forget(): Promise<void>;
}

/** Default recall query when loading a session brief. */
export const DECISION_RECALL_QUERY =
  "Stable product and architecture decisions for this codebase. Prefer latest.";

/** Context tag sent to HTTP backends on retain. */
export const DECISION_CONTEXT = "tsforge-decision";

/** Soft cap for injected decision brief (characters ≈ tokens×4). ~600 tokens. */
export const DECISION_BRIEF_MAX_CHARS = 2400;
