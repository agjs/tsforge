import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { PACK_REGISTRY } from "../stack-detection";
import { parseMcpServers, type IMcpServerConfig } from "../mcp";

/**
 * User-defined configuration from tsforge.config.json
 * Allows users to tune the opinionated guardrails — override detected packs,
 * include/exclude packs, and tune rule severities (eslint packs + meta-rules).
 */
export interface ITsforgeProjectConfig {
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

/** Validate each known field of an already-parsed config object, dropping any
 *  that fail their per-field validator. Kept separate from the file IO so the
 *  loader stays simple. */
function buildConfigFields(
  parsed: Record<string, unknown>
): ITsforgeProjectConfig {
  const configFields: {
    stack?: string;
    packs?: { include?: readonly string[]; exclude?: readonly string[] };
    rules?: Record<string, "error" | "warn" | "off">;
    mcpServers?: Record<string, IMcpServerConfig>;
  } = {};

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
  const normalized: Record<string, "error" | "warn" | "off"> = {};

  for (const [key, severity] of Object.entries(config.rules ?? {})) {
    // Runtime data can violate the declared union (hand-built configs in tests,
    // partially validated JSON) — re-check before trusting it.
    if (!isSeverityOverride(severity)) {
      continue;
    }

    const bareKey = key.startsWith("tsforge/") ? key.slice(8) : key;

    if (bareKey.length > 0) {
      normalized[bareKey] = severity;
    }
  }

  return normalized;
}
