import { isRecord } from "../lib/guards";
import type {
  IHttpMemoryProviderConfig,
  IMcpMemoryProviderConfig,
  IMemoryProviderConfig,
} from "../loop/memory/provider.types";

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

  return bankId === undefined
    ? { kind: "http", baseUrl }
    : { kind: "http", baseUrl, bankId };
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

/** Parse the optional `providers` block. Only `memory` is supported in v1. */
export function parseProviders(raw: unknown):
  | { readonly memory?: IMemoryProviderConfig }
  | undefined {
  if (!isRecord(raw)) {
    warnProviders('tsforge.config.json: "providers" must be an object — ignored');

    return undefined;
  }

  if (raw.memory === undefined) {
    return {};
  }

  const memory = parseMemoryProviderConfig(raw.memory);

  return memory === undefined ? {} : { memory };
}
