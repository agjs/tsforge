/**
 * Unified action policy: the model proposes, the harness enforces. Every tool
 * call is classified into an `IProposedAction` and run through `evaluatePolicy`
 * (deny-first) BEFORE execution. This module is a leaf — it imports only pure
 * helpers (lib/scope), never the loop/tool layer — so there are no cycles and
 * `evaluatePolicy` stays a pure, fully unit-testable function.
 */

/** The three possible verdicts. `ask` resolves to `deny` when non-interactive. */
export type PolicyDecision = "allow" | "ask" | "deny";

/** Enforcement strength. `plan` is the read-only explore mode; `default` is the
 *  autonomous drive-to-green default; the rest tighten or loosen from there. */
export type PolicyMode =
  "plan" | "default" | "acceptEdits" | "ci" | "dontAsk" | "bypassPermissions";

/** What a tool call actually does, independent of the tool's name. */
export type ActionKind =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "shell"
  | "network"
  | "mcp_tool"
  | "plugin_tool"
  /** A harness-controlled tool whose ENTIRE argument surface is ignored or
   *  fixed by the harness — `check` runs the frozen gate command and ignores
   *  its args. Zero model-chosen input, so it carries none of `shell`'s risk;
   *  allowed in every mode except `plan` (where `executeTool`'s read-only guard
   *  still blocks a non-read-only tool). */
  | "harness_tool"
  /** Delegating a read-only investigation to a subagent (`spawn_agent`). The
   *  spawn itself mutates nothing; the child is read-only-enforced separately.
   *  Its own action class so a repo can deny/ask delegation specifically. */
  | "spawn_agent"
  | "unknown";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** A tool call reduced to the facts a policy needs. Built by `classifyAction`. */
export interface IProposedAction {
  kind: ActionKind;
  toolName: string;
  input: unknown;
  cwd: string;
  /** Workspace-relative paths the action touches (normalized). */
  paths?: readonly string[];
  /** Shell command preview (for `shell` actions). */
  command?: string;
  /** Server name for an `mcp__<server>__<tool>` call. */
  mcpServer?: string;
  metadata?: Record<string, unknown>;
}

export interface IPolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
  matchedRules: readonly string[];
  risk: RiskLevel;
  requiresHumanApproval: boolean;
}

/**
 * A single config-driven rule. Every PRESENT field must match (AND); an empty
 * rule matches everything (a catch-all). Kept deliberately small — no DSL.
 */
export interface IPolicyRule {
  kind?: ActionKind;
  toolName?: string;
  /** Glob (Bun.Glob) matched against any of the action's paths. */
  pathPattern?: string;
  /** The action's command must start with this string. */
  commandPrefix?: string;
  /** Regex source matched against the action's command. */
  commandPattern?: string;
  mcpServer?: string;
}

/** The deny/allow/ask rule lists from `tsforge.config.json` `policy.rules`. */
export interface IPolicyRules {
  deny?: readonly IPolicyRule[];
  allow?: readonly IPolicyRule[];
  ask?: readonly IPolicyRule[];
}

/** Ambient state `evaluatePolicy` reads. Built from `IToolContext` + config. */
export interface IPolicyContext {
  mode: PolicyMode;
  cwd: string;
  /** Editable scope globs (mirrors `IToolContext.files`). */
  files: readonly string[];
  /** Whether a real interactive approval path exists. False today ⇒ `ask`
   *  resolves to `deny` (TSForge has no per-action approval prompt yet). */
  interactive: boolean;
  /** Config-driven rules, evaluated deny → allow → ask before the mode default. */
  rules?: IPolicyRules;
  /** Registered MCP server names; an `mcp_tool` for any other server is a
   *  critical deny (catches a forged/unregistered server call). */
  mcpServers?: readonly string[];
}
