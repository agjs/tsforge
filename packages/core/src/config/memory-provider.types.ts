/**
 * Config shapes for pluggable PROJECT DECISION memory (`providers.memory`).
 * Lives under `config/` so config parsing does not import `loop/` (arch seam).
 */

/** Supported provider kinds in tsforge.config.json `providers.memory`. */
export type MemoryProviderKind = "http" | "mcp";

/**
 * Send the user's own prompt text to the bank when a send goes green.
 *
 * OFF by default, deliberately. Verified-feature retains are curated strings
 * that tsforge builds; this one is the raw request the user typed, which
 * routinely carries pasted logs, snippets and customer data. Redaction only
 * catches secret-SHAPED text, so everything else in a prompt would leave the
 * machine. It also fills the bank with prompts rather than decisions, which
 * makes recall worse as it grows. Opt in when the bank is private and that
 * trade is wanted.
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
