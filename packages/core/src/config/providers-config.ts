import { isRecord } from "../lib/guards";
import type {
  IHttpMemoryProviderConfig,
  IMcpMemoryProviderConfig,
  IMemoryProviderConfig,
} from "./memory-provider.types";

function warnProviders(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `autoRetain` — ON unless explicitly `false`.
 *
 * Only the opt-out is carried on the parsed config; `undefined` means default
 * (on). Legacy `retainPrompts: false` still opts out; `retainPrompts: true` is
 * obsolete (raw prompt dump removed) and is ignored with a warning.
 */
function autoRetainFlag(raw: Record<string, unknown>): boolean | undefined {
  const auto = raw.autoRetain;

  if (typeof auto === "boolean") {
    return auto ? undefined : false;
  }

  if (auto !== undefined) {
    warnProviders(
      `tsforge.config.json: providers.memory.autoRetain must be a boolean — got ${JSON.stringify(auto)} (using the default: enabled)`
    );
  }

  const legacy = raw.retainPrompts;

  if (legacy === false) {
    return false;
  }

  if (legacy === true) {
    warnProviders(
      "tsforge.config.json: providers.memory.retainPrompts is obsolete (raw prompt retain removed); use autoRetain (default on) or autoRetain: false to opt out"
    );

    return undefined;
  }

  if (legacy !== undefined) {
    warnProviders(
      `tsforge.config.json: providers.memory.retainPrompts must be a boolean — got ${JSON.stringify(legacy)} (using the default: enabled)`
    );
  }

  return undefined;
}

function retentionFields(raw: Record<string, unknown>): { autoRetain?: false } {
  const autoRetain = autoRetainFlag(raw);

  if (autoRetain === false) {
    return { autoRetain: false };
  }

  return {};
}

function parseHttpMemory(
  raw: Record<string, unknown>
): IHttpMemoryProviderConfig | null {
  const baseUrl = optionalString(raw.baseUrl);

  if (baseUrl === undefined) {
    warnProviders(
      'tsforge.config.json: providers.memory kind "http" requires a non-empty "baseUrl"'
    );

    return null;
  }

  const bankId = optionalString(raw.bankId);

  return {
    kind: "http",
    baseUrl,
    ...(bankId === undefined ? {} : { bankId }),
    ...retentionFields(raw),
  };
}

function parseMcpMemory(
  raw: Record<string, unknown>
): IMcpMemoryProviderConfig | null {
  const server = optionalString(raw.server);

  if (server === undefined) {
    warnProviders(
      'tsforge.config.json: providers.memory kind "mcp" requires a non-empty "server"'
    );

    return null;
  }

  const bankId = optionalString(raw.bankId);
  const retainTool = optionalString(raw.retainTool);
  const recallTool = optionalString(raw.recallTool);
  const forgetTool = optionalString(raw.forgetTool);
  const listTool = optionalString(raw.listTool);

  return {
    kind: "mcp",
    server,
    ...retentionFields(raw),
    ...(bankId === undefined ? {} : { bankId }),
    ...(retainTool === undefined ? {} : { retainTool }),
    ...(recallTool === undefined ? {} : { recallTool }),
    ...(forgetTool === undefined ? {} : { forgetTool }),
    ...(listTool === undefined ? {} : { listTool }),
  };
}

/**
 * Parse `providers.memory` from tsforge.config.json. Unknown/invalid kinds warn
 * and return undefined (fail-soft — session runs without decision memory).
 */
export function parseMemoryProviderConfig(
  raw: unknown
): IMemoryProviderConfig | undefined {
  if (!isRecord(raw)) {
    warnProviders(
      'tsforge.config.json: "providers.memory" must be an object — ignored'
    );

    return undefined;
  }

  const kind = raw.kind;

  if (kind === "http") {
    return parseHttpMemory(raw) ?? undefined;
  }

  if (kind === "mcp") {
    return parseMcpMemory(raw) ?? undefined;
  }

  warnProviders(
    `tsforge.config.json: providers.memory.kind must be "http" or "mcp" — got ${JSON.stringify(kind)} (ignored)`
  );

  return undefined;
}

export interface IProvidersConfig {
  readonly memory?: IMemoryProviderConfig;
}

/** Parse the optional `providers` block. Only `memory` is supported in v1. */
export function parseProviders(raw: unknown): IProvidersConfig | undefined {
  if (!isRecord(raw)) {
    warnProviders(
      'tsforge.config.json: "providers" must be an object — ignored'
    );

    return undefined;
  }

  if (raw.memory === undefined) {
    return {};
  }

  const memory = parseMemoryProviderConfig(raw.memory);

  return memory === undefined ? {} : { memory };
}
