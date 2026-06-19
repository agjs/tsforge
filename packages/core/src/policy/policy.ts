import { isDestructiveShell, isPrivateKeyPath } from "./patterns";
import type {
  ActionKind,
  IPolicyContext,
  IPolicyEvaluation,
  IPolicyRule,
  IProposedAction,
  PolicyDecision,
  PolicyMode,
  RiskLevel,
} from "./policy.types";

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
 *  here: the write tools already enforce `writable`/`isVendored` in every mode
 *  (and scaffold tools legitimately author vendored files), so duplicating it
 *  here would only front-run their richer, model-guiding rejection messages. */
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

  if (action.kind === "read_file" && action.paths !== undefined) {
    const key = action.paths.find((p) => isPrivateKeyPath(p));

    if (key !== undefined) {
      return {
        reason: `private-key file read blocked: ${key}`,
        rule: "critical:private-key-read",
      };
    }
  }

  if (
    action.kind === "mcp_tool" &&
    action.mcpServer !== undefined &&
    ctx.mcpServers !== undefined &&
    !ctx.mcpServers.includes(action.mcpServer)
  ) {
    return {
      reason: `unregistered MCP server blocked: ${action.mcpServer}`,
      rule: "critical:unregistered-mcp",
    };
  }

  return null;
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A malformed regex in config never matches (config load also warns on it).
    return false;
  }
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

  if (
    rule.commandPattern !== undefined &&
    !safeRegexTest(rule.commandPattern, action.command ?? "")
  ) {
    return false;
  }

  if (rule.pathPattern !== undefined) {
    const glob = new Bun.Glob(rule.pathPattern);

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
