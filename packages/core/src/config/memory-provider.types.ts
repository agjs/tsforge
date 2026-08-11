/**
 * Config shapes for pluggable PROJECT DECISION memory (`providers.memory`).
 * Lives under `config/` so config parsing does not import `loop/` (arch seam).
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
  IHttpMemoryProviderConfig | IMcpMemoryProviderConfig;
