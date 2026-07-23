import {
  commandReadsPrivateKey,
  isDestructiveShell,
  isPrivateKeyPath,
  pipesToShell,
} from "./patterns";
import type {
  ActionKind,
  IPolicyContext,
  IPolicyEvaluation,
  IPolicyRule,
  IPolicyRules,
  IProposedAction,
  PolicyDecision,
  PolicyMode,
  RiskLevel,
} from "./policy.types";

/**
 * Merge two optional rule sets by APPENDING each list (deny/allow/ask). Returns `undefined`
 * only when BOTH are absent, preserving the "no rules" fast path. Deny-first evaluation means
 * an appended deny still wins over a base allow — so a backend can inject a hard prohibition
 * on top of the user's config without editing it. Empty result lists are omitted.
 */
export function mergePolicyRules(
  base: IPolicyRules | undefined,
  extra: IPolicyRules | undefined
): IPolicyRules | undefined {
  if (base === undefined) {
    return extra;
  }

  if (extra === undefined) {
    return base;
  }

  const deny = [...(base.deny ?? []), ...(extra.deny ?? [])];
  const allow = [...(base.allow ?? []), ...(extra.allow ?? [])];
  const ask = [...(base.ask ?? []), ...(extra.ask ?? [])];

  return {
    ...(deny.length > 0 ? { deny } : {}),
    ...(allow.length > 0 ? { allow } : {}),
    ...(ask.length > 0 ? { ask } : {}),
  };
}

/** Every valid policy mode — the single source for config/CLI validation. */
export const POLICY_MODES: readonly PolicyMode[] = [
  "plan",
  "default",
  "acceptEdits",
  "ci",
  "dontAsk",
  "bypassPermissions",
];

const POLICY_MODE_SET = new Set<string>(POLICY_MODES);

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === "string" && POLICY_MODE_SET.has(value);
}

/** Every action kind — for validating a config rule's `kind` field. */
export const ACTION_KINDS: readonly ActionKind[] = [
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "shell",
  "network",
  "mcp_tool",
  "plugin_tool",
  "spawn_agent",
  "unknown",
];

const ACTION_KIND_SET = new Set<string>(ACTION_KINDS);

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && ACTION_KIND_SET.has(value);
}

/**
 * Per-mode default verdict for each action kind — consulted only AFTER critical
 * denies and config rules. `default` preserves TSForge's autonomous
 * drive-to-green behavior (reads, scoped writes, shell, network all allowed);
 * `plan` is read-only; the rest tighten. `bypassPermissions` allows everything
 * here, but the critical-deny set still fires before this table is reached.
 */
/**
 * Per-mode default decision for each action kind (a rule can still override, and
 * critical denies always win). The intentional postures:
 * - `default`: interactive day-to-day — writes/shell/network allowed, delete + the
 *   unknown action ask/deny.
 * - `plan`: read-only exploration — writes/mcp denied; shell allowed but the run
 *   tool's own `isReadOnlyCommand` guard keeps it read-only.
 * - `acceptEdits`: interactive auto-accept of edits, but shell still ASKS (the one
 *   field that distinguishes it from the automation modes) and network is denied.
 * - `ci` and `dontAsk` are intentionally IDENTICAL: both are non-interactive, so
 *   anything that would otherwise prompt is denied outright (shell/network/unknown
 *   = deny). Kept as two named modes because they signal different intent at the
 *   call site (CI pipeline vs. a local "never prompt me" run) and may diverge later.
 * - `bypassPermissions`: allow everything (the escape hatch; critical denies still apply).
 */
const MODE_MATRIX: Readonly<
  Record<PolicyMode, Record<ActionKind, PolicyDecision>>
> = {
  default: {
    read_file: "allow",
    write_file: "allow",
    edit_file: "allow",
    delete_file: "deny",
    shell: "allow",
    network: "allow",
    mcp_tool: "allow",
    plugin_tool: "allow",
    spawn_agent: "allow",
    unknown: "ask",
  },
  plan: {
    read_file: "allow",
    write_file: "deny",
    edit_file: "deny",
    delete_file: "deny",
    // `run` is allowed through here; the tool's own isReadOnlyCommand guard
    // restricts it to read-only commands in plan mode.
    shell: "allow",
    network: "allow",
    mcp_tool: "deny",
    plugin_tool: "deny",
    spawn_agent: "allow",
    unknown: "deny",
  },
  acceptEdits: {
    read_file: "allow",
    write_file: "allow",
    edit_file: "allow",
    delete_file: "deny",
    shell: "ask",
    network: "deny",
    mcp_tool: "allow",
    plugin_tool: "allow",
    spawn_agent: "allow",
    unknown: "deny",
  },
  ci: {
    read_file: "allow",
    write_file: "allow",
    edit_file: "allow",
    delete_file: "deny",
    shell: "deny",
    network: "deny",
    mcp_tool: "allow",
    plugin_tool: "allow",
    spawn_agent: "allow",
    unknown: "deny",
  },
  dontAsk: {
    read_file: "allow",
    write_file: "allow",
    edit_file: "allow",
    delete_file: "deny",
    shell: "deny",
    network: "deny",
    mcp_tool: "allow",
    plugin_tool: "allow",
    spawn_agent: "allow",
    unknown: "deny",
  },
  bypassPermissions: {
    read_file: "allow",
    write_file: "allow",
    edit_file: "allow",
    delete_file: "allow",
    shell: "allow",
    network: "allow",
    mcp_tool: "allow",
    plugin_tool: "allow",
    spawn_agent: "allow",
    unknown: "allow",
  },
};

const WRITE_KINDS: ReadonlySet<ActionKind> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
]);

function riskOf(kind: ActionKind): RiskLevel {
  if (kind === "shell" || kind === "unknown") {
    return "high";
  }

  if (
    kind === "network" ||
    kind === "mcp_tool" ||
    kind === "plugin_tool" ||
    WRITE_KINDS.has(kind)
  ) {
    return "medium";
  }

  return "low";
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface ICriticalHit {
  reason: string;
  rule: string;
}

/** Denials that win in EVERY mode (incl. bypassPermissions). Returns null when
 *  nothing critical matches. These are protections with NO unconditional
 *  tool-local equivalent. Out-of-scope and vendored writes are deliberately NOT
 *  here: the write tools already enforce `writable` in every mode, so duplicating
 *  it here would only front-run their richer, model-guiding rejection messages. */
function criticalDeny(
  action: IProposedAction,
  ctx: IPolicyContext
): ICriticalHit | null {
  if (
    action.kind === "shell" &&
    action.command !== undefined &&
    isDestructiveShell(action.command)
  ) {
    return {
      reason: `destructive shell command blocked: ${preview(action.command)}`,
      rule: "critical:destructive-shell",
    };
  }

  if (
    action.kind === "shell" &&
    action.command !== undefined &&
    pipesToShell(action.command)
  ) {
    return {
      reason: `piping into a shell interpreter blocked: ${preview(action.command)}`,
      rule: "critical:pipe-to-shell",
    };
  }

  if (action.kind === "read_file" && action.paths !== undefined) {
    const key = action.paths.find((p) => isPrivateKeyPath(p));

    if (key !== undefined) {
      return {
        reason: `private-key file read blocked: ${key}`,
        rule: "critical:private-key-read",
      };
    }
  }

  // The `read` tool's private-key deny holds in every mode; a shell command that
  // reads the same material (`cat ~/.ssh/id_rsa`) must not be a side door around it.
  if (
    action.kind === "shell" &&
    action.command !== undefined &&
    commandReadsPrivateKey(action.command)
  ) {
    return {
      reason: `private-key file access blocked: ${preview(action.command)}`,
      rule: "critical:private-key-read",
    };
  }

  if (
    action.kind === "mcp_tool" &&
    action.mcpServer !== undefined &&
    // Undefined ⇒ no MCP servers configured ⇒ NO mcp tool is registered, so any
    // `mcp__*` call must be denied (not waved through to the mode default).
    !(ctx.mcpServers ?? []).includes(action.mcpServer)
  ) {
    return {
      reason: `unregistered MCP server blocked: ${action.mcpServer}`,
      rule: "critical:unregistered-mcp",
    };
  }

  return null;
}

// Compiled-pattern caches keyed by the rule object — evaluatePolicy runs on
// every tool call, so we compile each rule's regex/glob ONCE, not per check.
// (Config rule objects are stable for a session; a malformed regex caches null
// so it simply never matches.)
const regexCache = new WeakMap<IPolicyRule, RegExp | null>();
const globCache = new WeakMap<IPolicyRule, Bun.Glob>();

function ruleRegex(rule: IPolicyRule, pattern: string): RegExp | null {
  const cached = regexCache.get(rule);

  if (cached !== undefined) {
    return cached;
  }

  let compiled: RegExp | null;

  try {
    compiled = new RegExp(pattern);
  } catch {
    // A malformed regex in config never matches (config load also warns on it).
    compiled = null;
  }

  regexCache.set(rule, compiled);

  return compiled;
}

function ruleGlob(rule: IPolicyRule, pattern: string): Bun.Glob {
  const cached = globCache.get(rule);

  if (cached !== undefined) {
    return cached;
  }

  const glob = new Bun.Glob(pattern);

  globCache.set(rule, glob);

  return glob;
}

/** Whether every PRESENT field of the rule matches the action (AND). An empty
 *  rule matches everything — a deliberate catch-all. */
function ruleMatches(rule: IPolicyRule, action: IProposedAction): boolean {
  if (rule.kind !== undefined && rule.kind !== action.kind) {
    return false;
  }

  if (rule.toolName !== undefined && rule.toolName !== action.toolName) {
    return false;
  }

  if (rule.mcpServer !== undefined && rule.mcpServer !== action.mcpServer) {
    return false;
  }

  if (
    rule.commandPrefix !== undefined &&
    !(action.command ?? "").startsWith(rule.commandPrefix)
  ) {
    return false;
  }

  if (rule.commandPattern !== undefined) {
    // A null (malformed) regex never matches.
    const regex = ruleRegex(rule, rule.commandPattern);

    if (regex?.test(action.command ?? "") !== true) {
      return false;
    }
  }

  if (rule.pathPattern !== undefined) {
    const glob = ruleGlob(rule, rule.pathPattern);

    if (!(action.paths ?? []).some((p) => glob.match(p))) {
      return false;
    }
  }

  return true;
}

interface IRuleHit {
  decision: PolicyDecision;
  id: string;
}

/** First matching config rule, deny → allow → ask. Null when none match. */
function matchConfigRules(
  action: IProposedAction,
  ctx: IPolicyContext
): IRuleHit | null {
  const rules = ctx.rules;

  if (rules === undefined) {
    return null;
  }

  const order: readonly {
    list?: readonly IPolicyRule[];
    decision: PolicyDecision;
  }[] = [
    { list: rules.deny, decision: "deny" },
    { list: rules.allow, decision: "allow" },
    { list: rules.ask, decision: "ask" },
  ];

  for (const { list, decision } of order) {
    const idx = (list ?? []).findIndex((rule) => ruleMatches(rule, action));

    if (idx >= 0) {
      return { decision, id: `config:${decision}[${idx}]` };
    }
  }

  return null;
}

function evaluation(
  decision: PolicyDecision,
  reason: string,
  matchedRules: readonly string[],
  risk: RiskLevel
): IPolicyEvaluation {
  return {
    decision,
    reason,
    matchedRules,
    risk,
    requiresHumanApproval: decision === "ask",
  };
}

/** A human-readable reason for a mode-default verdict — informative for the
 *  model (especially the plan-mode read-only nudge), while `matchedRules` keeps
 *  the stable `mode:<mode>` id for the ledger/tests. */
function modeReason(
  mode: PolicyMode,
  kind: ActionKind,
  decision: PolicyDecision
): string {
  if (kind === "unknown") {
    return "unrecognized action — unknown tools are never run without explicit approval";
  }

  if (decision !== "deny") {
    return `mode:${mode}`;
  }

  if (mode === "plan") {
    return "plan mode is read-only — explore with read-only tools and present your plan as text; the user must approve it before files can change";
  }

  return `${mode} mode does not allow this ${kind} action (ambiguous/unsafe actions are not auto-approved)`;
}

/** Resolve a decision: an `ask` with no interactive approval path becomes a
 *  `deny` (TSForge has no per-action prompt yet, so this is always the case). */
function resolve(
  decision: PolicyDecision,
  reason: string,
  matchedRules: readonly string[],
  action: IProposedAction,
  ctx: IPolicyContext
): IPolicyEvaluation {
  const risk = riskOf(action.kind);

  if (decision === "ask" && !ctx.interactive) {
    return evaluation(
      "deny",
      `${reason} — ask requires approval, none available (non-interactive)`,
      matchedRules,
      risk
    );
  }

  return evaluation(decision, reason, matchedRules, risk);
}

/**
 * The single deny-first policy decision. Order: critical denies (every mode) →
 * config deny/allow/ask rules → the active mode's default. Unknown actions are
 * never silently allowed; `ask` collapses to `deny` when non-interactive.
 */
export function evaluatePolicy(
  action: IProposedAction,
  ctx: IPolicyContext
): IPolicyEvaluation {
  const critical = criticalDeny(action, ctx);

  if (critical !== null) {
    return evaluation("deny", critical.reason, [critical.rule], "critical");
  }

  const ruled = matchConfigRules(action, ctx);

  if (ruled !== null) {
    return resolve(ruled.decision, ruled.id, [ruled.id], action, ctx);
  }

  const base = MODE_MATRIX[ctx.mode][action.kind];

  return resolve(
    base,
    modeReason(ctx.mode, action.kind, base),
    [`mode:${ctx.mode}`],
    action,
    ctx
  );
}
