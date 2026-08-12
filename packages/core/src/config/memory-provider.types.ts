/**
 * Config shapes for pluggable PROJECT DECISION memory (`providers.memory`).
 * Lives under `config/` so config parsing does not import `loop/` (arch seam).
 */

/** Supported provider kinds in tsforge.config.json `providers.memory`. */
export type MemoryProviderKind = "http" | "mcp";

/**
 * Send the user's own prompt text to the bank when a send goes green.
 *
 * ON by default: without it a bank only ever fills from greenfield
 * feature-verified runs, so ordinary interactive sessions teach it nothing and
 * the recalled brief stays empty — which reads as "memory is broken".
 *
 * Set `false` to opt out. Worth doing when the bank is shared or hosted by
 * someone else: this stores the raw request as typed (first 500 chars), and
 * redaction only strips secret-SHAPED text (`API_KEY=`, `password:`, `sk-…`),
 * so pasted logs, snippets and customer data go as-is.
 */
interface IMemoryRetentionOptions {
  readonly retainPrompts?: boolean;
}

/** HTTP backend config (Hindsight-compatible retain/recall API shape). */
export interface IHttpMemoryProviderConfig extends IMemoryRetentionOptions {
  readonly kind: "http";
  readonly baseUrl: string;
  /** Override bank id; otherwise resolved from git remote or project path. */
  readonly bankId?: string;
}

/** MCP backend: map retain/recall/forget onto tools on a named mcpServers entry. */
export interface IMcpMemoryProviderConfig extends IMemoryRetentionOptions {
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
