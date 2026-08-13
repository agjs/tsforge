/**
 * Config shapes for pluggable PROJECT DECISION memory (`providers.memory`).
 * Lives under `config/` so config parsing does not import `loop/` (arch seam).
 */

/** Supported provider kinds in tsforge.config.json `providers.memory`. */
export type MemoryProviderKind = "http" | "mcp";

/**
 * Retention options for post-green decision capture.
 *
 * `autoRetain` — ON unless explicitly `false`. When on, a green interactive
 * send runs a bounded LLM extraction for durable product/architecture
 * decisions (0..N) and retains those — never the raw user prompt.
 *
 * Legacy `retainPrompts: false` still opts out (compat). `retainPrompts: true`
 * is obsolete (prompt dump removed) and is ignored with a warning.
 */
interface IMemoryRetentionOptions {
  readonly autoRetain?: boolean;
  /**
   * @deprecated Prompt dump removed. Use `autoRetain: false` to disable
   * post-green extraction. `false` still opts out for compatibility.
   */
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
