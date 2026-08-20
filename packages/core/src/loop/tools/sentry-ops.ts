import { flags } from "../../config";
import { str, reject, type IToolContext } from "./tool-context";
import { intArg, capHead } from "./vcs-common";
import {
  callFirst,
  field,
  isRecord,
  jsonParseSafe,
  asList,
  resolveMcpCapability,
  type IIntegrationRegistry,
} from "./integration-common";
import { LOOP_LIMITS } from "../loop.constants";

/** Required config key for the Sentry MCP server (verbs address `mcp__sentry__*`). */
export const SENTRY_SERVER = "sentry";

const CAPABILITY_OFF =
  "the Sentry capability is off — add a `sentry` MCP server to tsforge.config.json " +
  "`mcpServers` (and ensure TSFORGE_NO_SENTRY is unset).";

export interface ISentryDeps {
  registry: IIntegrationRegistry | undefined;
}

/** Resolve the `sentry` capability = consent (a `sentry` MCP server connected). */
export function resolveSentryCapability(
  registry: { serverNames(): string[] } | null | undefined
): boolean {
  return resolveMcpCapability(registry, SENTRY_SERVER, flags.noSentry());
}

/** The stacktrace text out of a Sentry issue/event payload, across shapes — a plain
 *  string field, or the newest event's rendered frames. Best-effort. */
function stacktraceOf(rec: Record<string, unknown>): string {
  const direct = field(rec, "stacktrace", "trace", "culpritTrace");

  if (direct.length > 0) {
    return direct;
  }

  const event = isRecord(rec.latestEvent)
    ? rec.latestEvent
    : isRecord(rec.event)
      ? rec.event
      : null;

  return event === null ? "" : field(event, "stacktrace", "message", "title");
}

function summarizeIssue(rec: Record<string, unknown>): string {
  const id = field(rec, "shortId", "id", "issueId");
  const title = field(rec, "title", "metadata_title", "culprit");
  const culprit = field(rec, "culprit");
  const level = field(rec, "level");
  const status = field(rec, "status");
  const count = field(rec, "count", "timesSeen", "events");
  const url = field(rec, "permalink", "url");
  const trace = stacktraceOf(rec);
  const lines = [`${id} ${title}`.trim()];
  const meta = [
    level.length > 0 ? `level: ${level}` : "",
    status.length > 0 ? `status: ${status}` : "",
    count.length > 0 ? `seen: ${count}×` : "",
  ]
    .filter((s) => s.length > 0)
    .join("  ");

  if (meta.length > 0) {
    lines.push(meta);
  }

  if (culprit.length > 0 && culprit !== title) {
    lines.push(`culprit: ${culprit}`);
  }

  if (url.length > 0) {
    lines.push(url);
  }

  if (trace.length > 0) {
    lines.push("", trace);
  }

  return lines.join("\n");
}

// ── reads ──────────────────────────────────────────────────────────────────

async function readIssue(
  reg: IIntegrationRegistry,
  id: string,
  max: number
): Promise<string> {
  const res = await callFirst(
    reg,
    SENTRY_SERVER,
    ["get_issue_details", "get_issue", "issue_details"],
    { issueId: id, id, issue_id: id }
  );

  if ("error" in res) {
    return res.error;
  }

  const parsed = jsonParseSafe(res.text);
  const rec = isRecord(parsed)
    ? parsed
    : Array.isArray(parsed) && isRecord(parsed[0])
      ? parsed[0]
      : null;

  return capHead(rec === null ? res.text : summarizeIssue(rec), max);
}

async function search(
  reg: IIntegrationRegistry,
  query: string,
  max: number
): Promise<string> {
  const res = await callFirst(
    reg,
    SENTRY_SERVER,
    ["search_issues", "find_issues", "list_issues"],
    { query }
  );

  if ("error" in res) {
    return res.error;
  }

  const rows = asList(jsonParseSafe(res.text))
    .filter(isRecord)
    .map((r) => {
      const id = field(r, "shortId", "id");
      const title = field(r, "title", "culprit");
      const level = field(r, "level");
      const count = field(r, "count", "timesSeen");

      return `${id} ${title}${level.length > 0 ? ` [${level}]` : ""}${
        count.length > 0 ? ` (${count}×)` : ""
      }`.trim();
    })
    .filter((line) => line.length > 0);

  return rows.length > 0 ? capHead(rows.join("\n"), max) : "no matching issues";
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read-only Sentry inspection (issue / search) via curated verbs over the Sentry MCP
 * server. No `ctx.sentry` guard — reads are policy-allowed in every mode
 * (integration_read); off ⇒ not advertised. Never throws.
 */
export async function doSentryRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ISentryDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  const reg = deps.registry;

  if (reg === undefined) {
    return reject(ctx, "sentry_read", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const id = str(args, "id");
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;

  ctx.report({ kind: "tool", task: ctx.task, message: `sentry_read ${op}` });

  switch (op) {
    case "issue":
      return id.trim().length === 0
        ? reject(ctx, "sentry_read", "issue: needs an issue `id`")
        : readIssue(reg, id, max);
    case "search":
      return search(reg, str(args, "query"), max);
    default:
      return reject(
        ctx,
        "sentry_read",
        `unknown op '${op}' (use issue|search)`
      );
  }
}

/**
 * Sentry WRITE (resolve) via a curated verb over MCP. Gated by the `sentry`
 * capability (consent) AND the integration_write policy kind. Fails closed when off,
 * even on a salvaged/forced call. Deliberately narrow — resolve only. Never throws.
 */
export async function doSentryWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ISentryDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  if (ctx.sentry !== true || deps.registry === undefined) {
    return reject(ctx, "sentry_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const id = str(args, "id");

  ctx.report({ kind: "tool", task: ctx.task, message: `sentry_write ${op}` });

  if (op !== "resolve") {
    return reject(ctx, "sentry_write", `unknown op '${op}' (use resolve)`);
  }

  if (id.trim().length === 0) {
    return reject(ctx, "sentry_write", "resolve: needs an issue `id`");
  }

  const res = await callFirst(
    deps.registry,
    SENTRY_SERVER,
    ["update_issue", "resolve_issue", "update-issue"],
    { issueId: id, id, issue_id: id, status: "resolved" }
  );

  return "error" in res ? res.error : `resolved ${id}`;
}
