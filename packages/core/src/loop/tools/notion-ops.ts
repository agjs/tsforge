import { flags } from "../../config";
import { str, reject, type IToolContext } from "./tool-context";
import { intArg, capHead } from "./vcs-common";
import {
  callFirst,
  field,
  isRecord,
  jsonParseSafe,
  asList,
  lintHumanText,
  resolveMcpCapability,
  type IIntegrationRegistry,
} from "./integration-common";
import { LOOP_LIMITS } from "../loop.constants";

/** Required config key for the Notion MCP server (verbs address `mcp__notion__*`). */
export const NOTION_SERVER = "notion";

const CAPABILITY_OFF =
  "the Notion capability is off — add a `notion` MCP server to tsforge.config.json " +
  "`mcpServers` (and ensure TSFORGE_NO_NOTION is unset).";

export interface INotionDeps {
  registry: IIntegrationRegistry | undefined;
}

/** Resolve the `notion` capability = consent (a `notion` MCP server connected). */
export function resolveNotionCapability(
  registry: { serverNames(): string[] } | null | undefined
): boolean {
  return resolveMcpCapability(registry, NOTION_SERVER, flags.noNotion());
}

function pageTitle(rec: Record<string, unknown>): string {
  // Notion pages carry the title in various shapes across MCP builds.
  const direct = field(rec, "title", "name");

  if (direct.length > 0) {
    return direct;
  }

  const props = rec.properties;

  return isRecord(props) ? field(props, "title", "Name", "name") : "";
}

// ── reads ──────────────────────────────────────────────────────────────────

async function search(
  reg: IIntegrationRegistry,
  query: string,
  max: number
): Promise<string> {
  const res = await callFirst(reg, NOTION_SERVER, ["search"], { query });

  if ("error" in res) {
    return res.error;
  }

  const rows = asList(jsonParseSafe(res.text))
    .filter(isRecord)
    .map((r) => {
      const title = pageTitle(r);
      const id = field(r, "id", "pageId", "page_id");
      const url = field(r, "url");

      return [title, id.length > 0 ? `(${id})` : "", url]
        .filter((s) => s.length > 0)
        .join("  ");
    })
    .filter((line) => line.length > 0);

  return rows.length > 0 ? capHead(rows.join("\n"), max) : "no matching pages";
}

async function readPage(
  reg: IIntegrationRegistry,
  id: string,
  max: number
): Promise<string> {
  const res = await callFirst(
    reg,
    NOTION_SERVER,
    ["get_page", "retrieve_page", "fetch", "get_page_content"],
    { id, pageId: id, page_id: id }
  );

  if ("error" in res) {
    return res.error;
  }

  const parsed = jsonParseSafe(res.text);

  if (!isRecord(parsed)) {
    return capHead(res.text, max);
  }

  const title = pageTitle(parsed);
  const url = field(parsed, "url");
  const content = field(parsed, "content", "text", "markdown", "body");
  const head = [title, url].filter((s) => s.length > 0).join("\n");

  return capHead(
    content.length > 0 ? `${head}\n\n${content}`.trim() : res.text,
    max
  );
}

// ── writes ─────────────────────────────────────────────────────────────────

async function createPage(
  reg: IIntegrationRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const title = str(args, "title");
  const content = str(args, "content");
  const parent = str(args, "parent");
  const titleLint = lintHumanText(title);

  if (titleLint !== null) {
    return `notion_write create: title ${titleLint}`;
  }

  const payload: Record<string, unknown> = { title };

  if (content.length > 0) {
    payload.content = content;
  }

  if (parent.length > 0) {
    payload.parent = parent;
    payload.parentId = parent;
  }

  const res = await callFirst(
    reg,
    NOTION_SERVER,
    ["create_page", "post_page", "create-page"],
    payload
  );

  if ("error" in res) {
    return res.error;
  }

  const rec = jsonParseSafe(res.text);
  const url = isRecord(rec) ? field(rec, "url") : "";

  return url.length > 0 ? `created page: ${url}` : "created page";
}

async function appendPage(
  reg: IIntegrationRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const id = str(args, "id");
  const content = str(args, "content");

  if (id.trim().length === 0) {
    return "notion_write append: needs a page `id`";
  }

  const lint = lintHumanText(content);

  if (lint !== null) {
    return `notion_write append: ${lint}`;
  }

  const res = await callFirst(
    reg,
    NOTION_SERVER,
    [
      "append_block_children",
      "patch_block_children",
      "append_to_page",
      "update_page",
    ],
    { id, pageId: id, page_id: id, content }
  );

  return "error" in res ? res.error : `appended to ${id}`;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read-only Notion inspection (search / page) via curated verbs over the Notion MCP
 * server. No `ctx.notion` guard — reads are policy-allowed in every mode
 * (integration_read); off ⇒ not advertised. Never throws.
 */
export async function doNotionRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: INotionDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  const reg = deps.registry;

  if (reg === undefined) {
    return reject(ctx, "notion_read", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const id = str(args, "id");
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;

  ctx.report({ kind: "tool", task: ctx.task, message: `notion_read ${op}` });

  switch (op) {
    case "search":
      return search(reg, str(args, "query"), max);
    case "page":
      return id.trim().length === 0
        ? reject(ctx, "notion_read", "page: needs a page `id`")
        : readPage(reg, id, max);
    default:
      return reject(ctx, "notion_read", `unknown op '${op}' (use search|page)`);
  }
}

/**
 * Notion WRITE (create / append) via curated verbs over MCP. Gated by the `notion`
 * capability (consent) AND the integration_write policy kind. Fails closed when off,
 * even on a salvaged/forced call. Never throws.
 */
export async function doNotionWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: INotionDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  if (ctx.notion !== true || deps.registry === undefined) {
    return reject(ctx, "notion_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");

  ctx.report({ kind: "tool", task: ctx.task, message: `notion_write ${op}` });

  switch (op) {
    case "create":
      return createPage(deps.registry, args);
    case "append":
      return appendPage(deps.registry, args);
    default:
      return reject(
        ctx,
        "notion_write",
        `unknown op '${op}' (use create|append)`
      );
  }
}
