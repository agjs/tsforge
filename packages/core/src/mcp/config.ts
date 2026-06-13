import { isRecord } from "../lib/guards";
import type { IMcpServerConfig } from "./mcp.types";

type EnvLookup = Readonly<Record<string, string | undefined>>;

/** Interpolate `${VAR}` references from `env` into a string (missing → ""). */
export function interpolateEnv(value: string, env: EnvLookup): string {
  return value.replace(
    /\$\{([A-Za-z0-9_]+)\}/g,
    (_match: string, name: string) => env[name] ?? ""
  );
}

function stringArray(value: unknown, env: EnvLookup): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => interpolateEnv(item, env));

  return out.length > 0 ? out : undefined;
}

function envRecord(
  value: unknown,
  env: EnvLookup
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[key] = interpolateEnv(raw, env);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse one server entry, applying env interpolation. Returns null if the entry
 *  is malformed or missing the field its transport requires. */
function parseOne(value: unknown, env: EnvLookup): IMcpServerConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = value.type === "http" ? "http" : "stdio";
  const command =
    typeof value.command === "string"
      ? interpolateEnv(value.command, env)
      : undefined;
  const url =
    typeof value.url === "string" ? interpolateEnv(value.url, env) : undefined;
  const timeoutMs =
    typeof value.timeoutMs === "number" && value.timeoutMs > 0
      ? value.timeoutMs
      : undefined;

  if (type === "stdio" && (command === undefined || command.length === 0)) {
    return null;
  }

  if (type === "http" && (url === undefined || url.length === 0)) {
    return null;
  }

  return {
    type,
    command,
    args: stringArray(value.args, env),
    env: envRecord(value.env, env),
    url,
    timeoutMs,
  };
}

/**
 * Parse the `mcpServers` block of tsforge.config.json into validated configs,
 * keyed by server name. Malformed or incomplete entries are dropped (the loader
 * warns); a missing/invalid block yields {}.
 */
export function parseMcpServers(
  raw: unknown,
  env: EnvLookup
): Record<string, IMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }

  const servers: Record<string, IMcpServerConfig> = {};

  for (const [name, value] of Object.entries(raw)) {
    const parsed = parseOne(value, env);

    if (parsed !== null) {
      servers[name] = parsed;
    }
  }

  return servers;
}
