import { mcpToolName, type IToolSchema } from "../../mcp";

/**
 * Shared primitives for the curated-verb-over-MCP integrations (Linear, Notion,
 * Sentry). Each integration wraps an MCP server behind a small, opinionated verb
 * set: this module holds the parts that are identical across all three — the
 * registry surface, the sentinel-error handling `McpRegistry.callTool` uses (it
 * never throws), tolerant JSON extraction, the alias-tolerant tool dispatch, the
 * capability resolver, the human-intent lint, and the raw-schema suppression.
 * Integration-specific summarizing/parsing stays in each `*-ops.ts`.
 */

/** The registry surface the curated verbs need: existence check + invoke. The real
 *  `McpRegistry` satisfies this structurally; tests pass a fake. */
export interface IIntegrationRegistry {
  has(name: string): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

/** `McpRegistry.callTool` never throws — a failure comes back as a sentinel string
 *  (`unknown MCP …` / `MCP tool …`) or empty. This detects that shape. */
export function isMcpError(raw: string): boolean {
  return (
    raw.startsWith("unknown MCP") ||
    raw.startsWith("MCP tool") ||
    raw.trim().length === 0
  );
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function jsonParseSafe(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return null;
  }
}

/** Coax a result list out of a parsed MCP payload that may be a bare array or an
 *  object wrapping the array under a common key (`results`/`data`/`issues`/…). */
export function asList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (isRecord(parsed)) {
    for (const key of [
      "results",
      "data",
      "issues",
      "pages",
      "items",
      "nodes",
    ]) {
      const v = parsed[key];

      if (Array.isArray(v)) {
        return v;
      }
    }
  }

  return [];
}

/** First present string/number field among `keys`, else "". */
export function field(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];

    if (typeof v === "string" && v.length > 0) {
      return v;
    }

    if (typeof v === "number") {
      return String(v);
    }
  }

  return "";
}

/** Call the first MCP tool (by short name) the server actually exposes — tolerates
 *  naming differences between MCP builds (e.g. create_issue vs save_issue). Returns
 *  the raw text, or an error string when none exist / the call failed. */
export async function callFirst(
  reg: IIntegrationRegistry,
  server: string,
  candidates: readonly string[],
  args: Record<string, unknown>
): Promise<{ text: string } | { error: string }> {
  for (const short of candidates) {
    const name = mcpToolName(server, short);

    if (reg.has(name)) {
      const raw = await reg.callTool(name, args);

      return isMcpError(raw) ? { error: raw } : { text: raw };
    }
  }

  return {
    error: `this ${server} MCP server exposes none of: ${candidates.join(", ")}`,
  };
}

/**
 * Resolve an integration capability = the user's consent. On iff the kill-switch is
 * unset AND a server keyed exactly `serverKey` is connected in the MCP registry
 * (configured + reachable). Connected IS consent — no probe. Never throws (any
 * error → false, fail closed).
 */
export function resolveMcpCapability(
  registry: { serverNames(): string[] } | null | undefined,
  serverKey: string,
  killed: boolean
): boolean {
  try {
    if (killed || registry === null || registry === undefined) {
      return false;
    }

    return registry.serverNames().includes(serverKey);
  } catch {
    return false;
  }
}

/** Soft lint for human-facing text a curated write produces (a Linear card, a Notion
 *  doc, …): reject empty; nudge away from code mechanics (line/file counts). SOFT so
 *  a genuinely code-detail task can still say what it means. Returns a reason, else
 *  null. */
export function lintHumanText(text: string): string | null {
  if (text.trim().length === 0) {
    return "empty — say the intent and the outcome for a human";
  }

  if (/\b\d+\s+(lines?|files?)\b/i.test(text) || /\bline count\b/i.test(text)) {
    return "drop the line/file counts — describe the intent and outcome, not code mechanics";
  }

  return null;
}

/**
 * The advertised MCP schemas with the raw `mcp__<server>__*` tools removed for every
 * server a curated capability owns (passed in `suppressedServers`). The tools stay
 * in the registry and remain dispatchable — this only trims the MODEL'S advertised
 * list so it isn't drowned by dozens of raw tools on top of the curated verbs. An
 * empty list ⇒ unchanged passthrough.
 */
export function suppressCuratedSchemas(
  schemas: readonly IToolSchema[],
  suppressedServers: readonly string[]
): IToolSchema[] {
  if (suppressedServers.length === 0) {
    return [...schemas];
  }

  const prefixes = suppressedServers.map((s) => `mcp__${s}__`);

  return schemas.filter(
    (s) => !prefixes.some((p) => s.function.name.startsWith(p))
  );
}
