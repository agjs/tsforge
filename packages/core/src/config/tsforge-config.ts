import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { PACK_REGISTRY } from "../stack-detection";
import { parseMcpServers, type IMcpServerConfig } from "../mcp";
import {
  isPolicyMode,
  isActionKind,
  POLICY_MODES,
  type PolicyMode,
  type IPolicyRule,
  type IPolicyRules,
} from "../policy";
import {
  isComponentFoldersConvention,
  isEnumConvention,
  isInterfaceConvention,
  isTestConvention,
} from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { parsePlugins, type IExternalPlugin } from "./external-plugins";
import {
  DEFAULT_PROFILE,
  isProfileId,
  mergeRuleOverrides,
  resolveProfileExtraPacks,
  resolveProfileMetaRuleOverrides,
  type ProfileId,
} from "./profiles";

/**
 * User-defined configuration from tsforge.config.json
 * Allows users to tune the opinionated guardrails — override detected packs,
 * include/exclude packs, and tune rule severities (eslint packs + meta-rules).
 */
export interface ITsforgeProjectConfig {
  /** Rule profile: recommended (default), strict, security, frontend, backend, opinionated. */
  readonly profile?: ProfileId;

  /** Force-enable a stack by name (skip detection heuristics, force-add its packs). */
  readonly stack?: string;

  /** Pack include/exclude — applied AFTER detection. */
  readonly packs?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };

  /**
   * ESLint rule + meta-rule severity overrides.
   * Keys: bare rule name ("timestamp-must-specify-mode") or tsforge-prefixed ("tsforge/timestamp-must-specify-mode").
   * Values: "error" | "warn" | "off" (off silences the rule).
   */
  readonly rules?: Readonly<Record<string, "error" | "warn" | "off">>;

  /**
   * External MCP (Model Context Protocol) servers whose tools are offered to the
   * agent. Keyed by a short server name. `${VAR}` references in string values are
   * interpolated from the environment at load time. Opt-in: absent ⇒ no MCP.
   */
  readonly mcpServers?: Readonly<Record<string, IMcpServerConfig>>;

  /**
   * External plugins providing extra rule packs, loaded without recompiling
   * tsforge. Each entry names a module (or relative path) and, optionally, which
   * exported packs to use. Opt-in: absent ⇒ only built-in packs.
   */
  readonly plugins?: readonly IExternalPlugin[];

  /**
   * Unified action-policy settings. `mode` sets the base enforcement strength
   * (overridden by `--policy-mode` and by plan mode); `rules` are deny/allow/ask
   * lists evaluated before the mode default (deny-first). Opt-in: absent ⇒ the
   * `default` mode with no extra rules.
   */
  readonly policy?: {
    readonly mode?: PolicyMode;
    readonly rules?: IPolicyRules;
  };

  /**
   * Project conventions inferred by `tsforge setup` — TASTE only (interface
   * naming, enums, test layout, component folders). Each field tunes a stylistic
   * rule; unset fields fall back to tsforge's house defaults. These can NEVER
   * relax the safety floor (no `any`/`as`/`!`, complexity, etc.). Opt-in: absent
   * ⇒ tsforge's default house style.
   */
  readonly conventions?: Readonly<Partial<IConventions>>;
}

function warnConfig(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function warnInvalidStackType(stackValue: unknown): void {
  const msg = `tsforge.config.json: "stack" must be a string, got ${typeof stackValue}`;

  warnConfig(msg);
}

function warnInvalidPacksType(packsValue: unknown): void {
  const msg = `tsforge.config.json: "packs" must be an object, got ${typeof packsValue}`;

  warnConfig(msg);
}

function warnInvalidPacksInclude(): void {
  warnConfig("tsforge.config.json: packs.include must be an array of strings");
}

function warnInvalidPacksExclude(): void {
  warnConfig("tsforge.config.json: packs.exclude must be an array of strings");
}

function warnInvalidRulesType(rulesValue: unknown): void {
  const msg = `tsforge.config.json: "rules" must be an object, got ${typeof rulesValue}`;

  warnConfig(msg);
}

function warnInvalidRuleSeverity(key: string, value: unknown): void {
  const msg = `tsforge.config.json: rule "${key}" severity must be "error", "warn", or "off", got "${String(value)}"`;

  warnConfig(msg);
}

function warnInvalidConventionsType(value: unknown): void {
  warnConfig(
    `tsforge.config.json: "conventions" must be an object, got ${typeof value}`
  );
}

function warnInvalidConvention(key: string, value: unknown): void {
  warnConfig(
    `tsforge.config.json: conventions.${key} has invalid value "${String(value)}" (ignored)`
  );
}

function warnInvalidJsonRoot(rootValue: unknown): void {
  const msg = `tsforge.config.json: expected object root, got ${typeof rootValue}`;

  warnConfig(msg);
}

function warnInvalidJson(msg: string | undefined): void {
  const displayMsg =
    msg !== undefined && msg.length > 0 ? msg : "parsing failed";

  warnConfig(`tsforge.config.json: invalid JSON — ${displayMsg}`);
}

function warnReadError(msg: string): void {
  warnConfig(`tsforge.config.json: read error — ${msg}`);
}

function warnUnknownPackInInclude(packId: string): void {
  const msg = `tsforge.config.json: unknown pack in packs.include: "${packId}" (will be ignored)`;

  warnConfig(msg);
}

function warnInvalidProfile(profileValue: unknown): void {
  warnConfig(
    `tsforge.config.json: "profile" must be one of recommended, strict, security, frontend, backend, opinionated — got "${String(profileValue)}"`
  );
}

/** Validate and extract profile field. */
function validateProfile(parsed: unknown): ProfileId | undefined {
  if (typeof parsed !== "string") {
    if (parsed !== undefined) {
      warnInvalidProfile(parsed);
    }

    return undefined;
  }

  if (isProfileId(parsed)) {
    return parsed;
  }

  warnInvalidProfile(parsed);

  return undefined;
}

/** Validate and extract stack field. */
function validateStack(parsed: unknown): string | undefined {
  if (typeof parsed === "string") {
    return parsed;
  }

  warnInvalidStackType(parsed);

  return undefined;
}

/** Validate and extract packs field. */
function validatePacks(
  parsed: unknown
): { include?: readonly string[]; exclude?: readonly string[] } | undefined {
  if (!isRecord(parsed)) {
    warnInvalidPacksType(parsed);

    return undefined;
  }

  const packFields: {
    include?: readonly string[];
    exclude?: readonly string[];
  } = {};

  if (parsed.include !== undefined) {
    if (
      Array.isArray(parsed.include) &&
      parsed.include.every((x) => typeof x === "string")
    ) {
      packFields.include = parsed.include;
    } else {
      warnInvalidPacksInclude();
    }
  }

  if (parsed.exclude !== undefined) {
    if (
      Array.isArray(parsed.exclude) &&
      parsed.exclude.every((x) => typeof x === "string")
    ) {
      packFields.exclude = parsed.exclude;
    } else {
      warnInvalidPacksExclude();
    }
  }

  return Object.keys(packFields).length > 0 ? packFields : undefined;
}

/** Validate and extract rules field. */
function validateRules(
  parsed: unknown
): Record<string, "error" | "warn" | "off"> | undefined {
  if (!isRecord(parsed)) {
    warnInvalidRulesType(parsed);

    return undefined;
  }

  const rulesFields: Record<string, "error" | "warn" | "off"> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (value === "error" || value === "warn" || value === "off") {
      rulesFields[key] = value;
    } else {
      warnInvalidRuleSeverity(key, value);
    }
  }

  return Object.keys(rulesFields).length > 0 ? rulesFields : undefined;
}

/** Validate the `conventions` block — warn-and-drop per sub-field. Each field is
 *  optional taste (interface naming, enums, test layout, component folders); an
 *  invalid value is warned and dropped so the resolved default applies. */
function validateConventions(
  parsed: unknown
): Readonly<Partial<IConventions>> | undefined {
  if (!isRecord(parsed)) {
    warnInvalidConventionsType(parsed);

    return undefined;
  }

  const out: { -readonly [K in keyof IConventions]?: IConventions[K] } = {};

  if (parsed.interfaces !== undefined) {
    if (isInterfaceConvention(parsed.interfaces)) {
      out.interfaces = parsed.interfaces;
    } else {
      warnInvalidConvention("interfaces", parsed.interfaces);
    }
  }

  if (parsed.enums !== undefined) {
    if (isEnumConvention(parsed.enums)) {
      out.enums = parsed.enums;
    } else {
      warnInvalidConvention("enums", parsed.enums);
    }
  }

  if (parsed.tests !== undefined) {
    if (isTestConvention(parsed.tests)) {
      out.tests = parsed.tests;
    } else {
      warnInvalidConvention("tests", parsed.tests);
    }
  }

  if (parsed.componentFolders !== undefined) {
    if (isComponentFoldersConvention(parsed.componentFolders)) {
      out.componentFolders = parsed.componentFolders;
    } else {
      warnInvalidConvention("componentFolders", parsed.componentFolders);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate each known field of an already-parsed config object, dropping any
 *  that fail their per-field validator. Kept separate from the file IO so the
 *  loader stays simple. */
/** A single policy rule — warn-and-drop: unknown/typed-wrong fields are dropped,
 *  an empty rule (matches everything) is a deliberate catch-all. */
function validatePolicyRule(parsed: unknown): IPolicyRule | undefined {
  if (!isRecord(parsed)) {
    warnConfig("tsforge.config.json: a policy rule must be an object");

    return undefined;
  }

  const rule: {
    kind?: IPolicyRule["kind"];
    toolName?: string;
    pathPattern?: string;
    commandPrefix?: string;
    commandPattern?: string;
    mcpServer?: string;
  } = {};

  if (isActionKind(parsed.kind)) {
    rule.kind = parsed.kind;
  }

  if (typeof parsed.toolName === "string") {
    rule.toolName = parsed.toolName;
  }

  if (typeof parsed.pathPattern === "string") {
    rule.pathPattern = parsed.pathPattern;
  }

  if (typeof parsed.commandPrefix === "string") {
    rule.commandPrefix = parsed.commandPrefix;
  }

  if (typeof parsed.commandPattern === "string") {
    rule.commandPattern = parsed.commandPattern;
  }

  if (typeof parsed.mcpServer === "string") {
    rule.mcpServer = parsed.mcpServer;
  }

  // A rule that PROVIDED fields but produced NO valid matcher (e.g. a typo like
  // `{ kind: "shel" }`) would collapse to `{}` — which the policy treats as a
  // match-EVERYTHING catch-all, turning a typo into a global allow/deny. Drop it
  // with a warning. A literal `{}` (no fields provided) is preserved as an
  // intentional catch-all.
  if (Object.keys(rule).length === 0 && Object.keys(parsed).length > 0) {
    warnConfig(
      "tsforge.config.json: a policy rule had fields but no valid matcher (all unknown/wrong-typed) — dropped (an empty rule would match everything)"
    );

    return undefined;
  }

  return rule;
}

function validateRuleList(parsed: unknown, label: string): IPolicyRule[] {
  if (!Array.isArray(parsed)) {
    warnConfig(`tsforge.config.json: policy.rules.${label} must be an array`);

    return [];
  }

  const out: IPolicyRule[] = [];

  for (const entry of parsed) {
    const rule = validatePolicyRule(entry);

    if (rule !== undefined) {
      out.push(rule);
    }
  }

  return out;
}

function validatePolicyRules(parsed: unknown): IPolicyRules | undefined {
  if (!isRecord(parsed)) {
    warnConfig('tsforge.config.json: "policy.rules" must be an object');

    return undefined;
  }

  const rules: {
    deny?: IPolicyRule[];
    allow?: IPolicyRule[];
    ask?: IPolicyRule[];
  } = {};

  if (parsed.deny !== undefined) {
    rules.deny = validateRuleList(parsed.deny, "deny");
  }

  if (parsed.allow !== undefined) {
    rules.allow = validateRuleList(parsed.allow, "allow");
  }

  if (parsed.ask !== undefined) {
    rules.ask = validateRuleList(parsed.ask, "ask");
  }

  return rules;
}

function validatePolicy(
  parsed: unknown
): { mode?: PolicyMode; rules?: IPolicyRules } | undefined {
  if (!isRecord(parsed)) {
    warnConfig(
      `tsforge.config.json: "policy" must be an object, got ${typeof parsed}`
    );

    return undefined;
  }

  const policy: { mode?: PolicyMode; rules?: IPolicyRules } = {};

  if (parsed.mode !== undefined) {
    if (isPolicyMode(parsed.mode)) {
      policy.mode = parsed.mode;
    } else {
      warnConfig(
        `tsforge.config.json: policy.mode must be one of ${POLICY_MODES.join(", ")}, got ${JSON.stringify(parsed.mode)}`
      );
    }
  }

  if (parsed.rules !== undefined) {
    policy.rules = validatePolicyRules(parsed.rules);
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** Validate + assign the optional `policy` block (kept off `buildConfigFields`
 *  so its per-field branches don't push the function over the complexity cap). */
function assignPolicy(
  parsed: Record<string, unknown>,
  configFields: { policy?: { mode?: PolicyMode; rules?: IPolicyRules } }
): void {
  if (parsed.policy === undefined) {
    return;
  }

  const policy = validatePolicy(parsed.policy);

  if (policy !== undefined) {
    configFields.policy = policy;
  }
}

/** Validate + assign the optional `conventions` block (kept off
 *  `buildConfigFields` so its per-field branches don't push it over the
 *  complexity cap — mirrors `assignPolicy`). */
function assignConventions(
  parsed: Record<string, unknown>,
  configFields: { conventions?: Readonly<Partial<IConventions>> }
): void {
  if (parsed.conventions === undefined) {
    return;
  }

  const conventions = validateConventions(parsed.conventions);

  if (conventions !== undefined) {
    configFields.conventions = conventions;
  }
}

function buildConfigFields(
  parsed: Record<string, unknown>
): ITsforgeProjectConfig {
  const configFields: {
    profile?: ProfileId;
    stack?: string;
    packs?: { include?: readonly string[]; exclude?: readonly string[] };
    rules?: Record<string, "error" | "warn" | "off">;
    mcpServers?: Record<string, IMcpServerConfig>;
    plugins?: readonly IExternalPlugin[];
    policy?: { mode?: PolicyMode; rules?: IPolicyRules };
    conventions?: Readonly<Partial<IConventions>>;
  } = {};

  if (parsed.profile !== undefined) {
    const profile = validateProfile(parsed.profile);

    if (profile !== undefined) {
      configFields.profile = profile;
    }
  }

  if (parsed.stack !== undefined) {
    const stack = validateStack(parsed.stack);

    if (stack !== undefined) {
      configFields.stack = stack;
    }
  }

  if (parsed.packs !== undefined) {
    const packs = validatePacks(parsed.packs);

    if (packs !== undefined) {
      configFields.packs = packs;
    }
  }

  if (parsed.rules !== undefined) {
    const rules = validateRules(parsed.rules);

    if (rules !== undefined) {
      configFields.rules = rules;
    }
  }

  if (parsed.mcpServers !== undefined) {
    const servers = parseMcpServers(parsed.mcpServers, process.env);

    if (Object.keys(servers).length > 0) {
      configFields.mcpServers = servers;
    }
  }

  if (parsed.plugins !== undefined) {
    const plugins = parsePlugins(parsed.plugins);

    if (plugins.length > 0) {
      configFields.plugins = plugins;
    }
  }

  assignPolicy(parsed, configFields);
  assignConventions(parsed, configFields);

  return configFields;
}

/** Load tsforge.config.json from cwd, defaulting to empty config on missing/invalid files. */
export async function loadTsforgeConfig(
  cwd: string
): Promise<ITsforgeProjectConfig> {
  const configPath = join(cwd, "tsforge.config.json");
  const file = Bun.file(configPath);

  const exists = await file.exists();

  if (!exists) {
    return {};
  }

  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);

    if (!isRecord(parsed)) {
      warnInvalidJsonRoot(parsed);

      return {};
    }

    return buildConfigFields(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      const firstLine = err.message.split("\n")[0];

      warnInvalidJson(firstLine);
    } else {
      const msg = err instanceof Error ? err.message : "unknown error";

      warnReadError(msg);
    }

    return {};
  }
}

/**
 * Resolve the active packs after applying config overrides.
 * Rules:
 *  1. Start with detected packs (from stack detection)
 *  2. If config.stack is set, force-add its packs (as if detected)
 *  3. Apply packs.include (add unknown packs with warning)
 *  4. Apply packs.exclude (remove known and unknown packs silently)
 *  5. Return deduplicated pack list
 */
export function resolveActivePacks(
  detectedPacks: readonly string[],
  config: ITsforgeProjectConfig
): readonly string[] {
  const packs = new Set(detectedPacks);

  // Force-add packs for config.stack if set
  if (config.stack !== undefined && config.stack.length > 0) {
    packs.add(config.stack);
  }

  // Profile extra packs (runtime-boundaries, authorization, typescript-core, …)
  for (const packId of resolveProfileExtraPacks(config.profile)) {
    if (packId in PACK_REGISTRY) {
      packs.add(packId);
    }
  }

  // Include: add packs (unknown ids are kept out of the registry lookup warning only)
  for (const packId of config.packs?.include ?? []) {
    if (packId.length === 0) {
      continue;
    }

    if (!(packId in PACK_REGISTRY)) {
      warnUnknownPackInInclude(packId);
    }

    packs.add(packId);
  }

  // Exclude: remove packs
  for (const packId of config.packs?.exclude ?? []) {
    packs.delete(packId);
  }

  // Return as sorted array for determinism
  return Array.from(packs).sort();
}

/**
 * Normalize rule name keys: accept both bare ("timestamp-must-specify-mode")
 * and tsforge-prefixed ("tsforge/timestamp-must-specify-mode").
 * Returns a map keyed by the BARE rule name.
 */
function isSeverityOverride(value: unknown): value is "error" | "warn" | "off" {
  return value === "error" || value === "warn" || value === "off";
}

export function normalizeRuleOverrides(
  config: ITsforgeProjectConfig
): Record<string, "error" | "warn" | "off"> {
  const userOverrides: Record<string, "error" | "warn" | "off"> = {};

  for (const [key, severity] of Object.entries(config.rules ?? {})) {
    if (!isSeverityOverride(severity)) {
      continue;
    }

    const bareKey = key.startsWith("tsforge/") ? key.slice(8) : key;

    if (bareKey.length > 0) {
      userOverrides[bareKey] = severity;
    }
  }

  return {
    ...resolveProfileMetaRuleOverrides(config.profile),
    ...mergeRuleOverrides(config.profile, userOverrides),
  };
}

export function resolveProjectProfile(
  config: ITsforgeProjectConfig
): ProfileId {
  return config.profile ?? DEFAULT_PROFILE;
}
