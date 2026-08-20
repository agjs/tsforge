import { mcpToolName, type IToolSchema } from "../../mcp";
import { flags } from "../../config";
import { runArgvCommand } from "../../lib/fs";
import { str, reject, type IToolContext } from "./tool-context";
import { unsafe, intArg, capHead, pick, type VcsRunner } from "./vcs-common";
import { LOOP_LIMITS } from "../loop.constants";

/** The required config key for the Linear MCP server. The curated verbs address
 *  its tools as `mcp__linear__<tool>`, so the server MUST be keyed exactly
 *  `linear` in tsforge.config.json `mcpServers`. */
export const LINEAR_SERVER = "linear";

const CAPABILITY_OFF =
  "the Linear capability is off — add a `linear` MCP server to tsforge.config.json " +
  "`mcpServers` (and ensure TSFORGE_NO_LINEAR is unset).";

/** The registry surface the curated verbs need: existence check + invoke. The real
 *  McpRegistry satisfies this structurally; tests pass a fake. */
export interface ILinearRegistry {
  has(name: string): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ILinearDeps {
  registry: ILinearRegistry | undefined;
  run: VcsRunner;
}

/** callTool never throws — a failure comes back as a sentinel string. */
function isMcpError(raw: string): boolean {
  return (
    raw.startsWith("unknown MCP") ||
    raw.startsWith("MCP tool") ||
    raw.trim().length === 0
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the `linear` capability = the user's consent to Linear operations. On iff
 * the TSFORGE_NO_LINEAR kill-switch is unset AND a server named exactly `linear` is
 * connected in the MCP registry (configured + reachable). Sync — the registry is
 * already connected by the driver. Never throws (any error → false, fail closed).
 */
export function resolveLinearCapability(
  registry: { serverNames(): string[] } | null | undefined
): boolean {
  try {
    if (flags.noLinear() || registry === null || registry === undefined) {
      return false;
    }

    return registry.serverNames().includes(LINEAR_SERVER);
  } catch {
    return false;
  }
}

/** The advertised MCP schemas, with the raw `mcp__linear__*` tools removed when the
 *  curated Linear capability owns them (unless TSFORGE_LINEAR_RAW re-exposes them).
 *  The tools stay in the registry and remain dispatchable — this only trims the
 *  MODEL'S advertised tool list so it isn't drowned by ~30 raw Linear tools on top
 *  of the 3 curated verbs. Off (linearOn=false) ⇒ unchanged passthrough. */
export function mcpSchemasForAdvertisement(
  schemas: readonly IToolSchema[],
  linearOn: boolean
): IToolSchema[] {
  if (!linearOn || flags.linearRaw()) {
    return [...schemas];
  }

  const prefix = `mcp__${LINEAR_SERVER}__`;

  return schemas.filter((s) => !s.function.name.startsWith(prefix));
}

/** Call the first Linear MCP tool (by short name) the registry actually exposes —
 *  tolerates naming differences between Linear MCP builds (create_issue vs
 *  save_issue, …). Returns the raw text, or an error string when none exist / the
 *  call failed. */
async function callLinear(
  reg: ILinearRegistry,
  candidates: readonly string[],
  args: Record<string, unknown>
): Promise<{ text: string } | { error: string }> {
  for (const short of candidates) {
    const name = mcpToolName(LINEAR_SERVER, short);

    if (reg.has(name)) {
      const raw = await reg.callTool(name, args);

      return isMcpError(raw) ? { error: raw } : { text: raw };
    }
  }

  return {
    error: `this Linear MCP server exposes none of: ${candidates.join(", ")}`,
  };
}

function field(rec: Record<string, unknown>, ...keys: string[]): string {
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

/** The git branch Linear generated for an issue payload, across field-name variants. */
function branchOf(rec: Record<string, unknown>): string {
  return field(rec, "branchName", "gitBranchName", "branch");
}

/** Compact, human-facing summary of one issue payload (never the raw MCP dump). */
function summarizeIssue(rec: Record<string, unknown>): string {
  const id = field(rec, "identifier", "id");
  const title = field(rec, "title", "name");
  const state = field(rec, "state", "status");
  const branch = branchOf(rec);
  const url = field(rec, "url");
  const description = field(rec, "description", "body");
  const lines = [`${id} ${title}`.trim()];

  if (state.length > 0) {
    lines.push(`state: ${state}`);
  }

  if (branch.length > 0) {
    lines.push(`branch: ${branch}  (linear_start ${id} checks it out)`);
  }

  if (url.length > 0) {
    lines.push(url);
  }

  if (description.length > 0) {
    lines.push("", description);
  }

  return lines.join("\n");
}

/** Pull an issue record out of an MCP payload that may be the object itself, a
 *  {text: json} wrapper, or a list whose first element is the issue. */
function issueRecord(raw: string): Record<string, unknown> | null {
  const parsed = jsonParse(raw);

  if (isRecord(parsed)) {
    if (typeof parsed.text === "string") {
      const inner = jsonParse(parsed.text);

      return isRecord(inner) ? inner : null;
    }

    return parsed;
  }

  if (Array.isArray(parsed) && isRecord(parsed[0])) {
    return parsed[0];
  }

  return null;
}

// ── reads ──────────────────────────────────────────────────────────────────

async function readIssue(
  reg: ILinearRegistry,
  id: string,
  max: number
): Promise<string> {
  const res = await callLinear(reg, ["get_issue"], { id });

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);

  return capHead(rec === null ? res.text : summarizeIssue(rec), max);
}

async function readList(
  reg: ILinearRegistry,
  candidates: readonly string[],
  args: Record<string, unknown>,
  max: number
): Promise<string> {
  const res = await callLinear(reg, candidates, args);

  if ("error" in res) {
    return res.error;
  }

  const parsed = jsonParse(res.text);

  if (!Array.isArray(parsed)) {
    return capHead(res.text, max);
  }

  const rows = parsed
    .filter(isRecord)
    .map((r) => {
      const id = field(r, "identifier", "id");
      const title = field(r, "title", "name");
      const state = field(r, "state", "status");

      return `${id} ${title}${state.length > 0 ? ` [${state}]` : ""}`.trim();
    })
    .filter((line) => line.length > 0);

  return rows.length > 0 ? capHead(rows.join("\n"), max) : "no matching issues";
}

// ── write lint (human-intent, not code mechanics) ────────────────────────────

/** Soft lint for a card title/description/comment: reject empty; nudge away from
 *  code mechanics (line/file counts). Mirrors lintPrBody — SOFT so a genuinely
 *  code-detail task can still say what it means. Returns a reason, or null. */
export function lintCardText(text: string): string | null {
  if (text.trim().length === 0) {
    return "empty — say the intent and the outcome for a human teammate";
  }

  if (/\b\d+\s+(lines?|files?)\b/i.test(text) || /\bline count\b/i.test(text)) {
    return "drop the line/file counts — describe the intent and outcome, not code mechanics";
  }

  return null;
}

// ── writes ─────────────────────────────────────────────────────────────────

async function createIssue(
  reg: ILinearRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const title = str(args, "title");
  const description = str(args, "description");
  const team = str(args, "team");
  const titleLint = lintCardText(title);

  if (titleLint !== null) {
    return `linear_write create: title ${titleLint}`;
  }

  // Description is optional, but if present it must read for a human.
  if (description.length > 0) {
    const descLint = lintCardText(description);

    if (descLint !== null) {
      return `linear_write create: description ${descLint}`;
    }
  }

  const payload: Record<string, unknown> = { title };

  if (description.length > 0) {
    payload.description = description;
  }

  if (team.length > 0) {
    payload.team = team;
    payload.teamId = team;
  }

  const res = await callLinear(reg, ["create_issue", "save_issue"], payload);

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);

  if (rec === null) {
    return res.text;
  }

  const id = field(rec, "identifier", "id");
  const branch = branchOf(rec);

  return branch.length > 0
    ? `created ${id} — branch ${branch} (linear_start ${id} to begin)`
    : `created ${id}`;
}

async function commentIssue(
  reg: ILinearRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const id = str(args, "id");
  const body = str(args, "body");

  if (id.trim().length === 0) {
    return "linear_write comment: needs an issue `id`";
  }

  const bodyLint = lintCardText(body);

  if (bodyLint !== null) {
    return `linear_write comment: ${bodyLint}`;
  }

  const res = await callLinear(reg, ["create_comment", "save_comment"], {
    issueId: id,
    id,
    body,
  });

  return "error" in res ? res.error : `commented on ${id}`;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read-only Linear inspection via curated verbs over the Linear MCP server. No
 * `ctx.linear` guard — reads are policy-allowed in every mode (integration_read);
 * if the capability is off the tool simply isn't advertised. Never throws.
 */
export async function doLinearRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  const reg = deps.registry;

  if (reg === undefined) {
    return reject(ctx, "linear_read", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const id = str(args, "id");
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_read ${op}` });

  switch (op) {
    case "issue":
      return id.trim().length === 0
        ? reject(ctx, "linear_read", "issue: needs an `id` (e.g. ENG-123)")
        : readIssue(reg, id, max);
    case "search":
      return readList(reg, ["list_issues"], { query: str(args, "query") }, max);
    case "mine":
      return readList(reg, ["list_my_issues", "list_issues"], {}, max);
    case "comments":
      return id.trim().length === 0
        ? reject(ctx, "linear_read", "comments: needs an issue `id`")
        : readList(reg, ["list_comments"], { issueId: id, id }, max);
    default:
      return reject(
        ctx,
        "linear_read",
        `unknown op '${op}' (use issue|search|mine|comments)`
      );
  }
}

/**
 * Linear WRITE via curated verbs over MCP — create / comment. Gated by the `linear`
 * capability (consent) AND the integration_write policy kind. Fails closed when the
 * capability is off, even on a salvaged/forced call. Never throws.
 */
export async function doLinearWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  if (ctx.linear !== true || deps.registry === undefined) {
    return reject(ctx, "linear_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_write ${op}` });

  switch (op) {
    case "create":
      return createIssue(deps.registry, args);
    case "comment":
      return commentIssue(deps.registry, args);
    default:
      return reject(
        ctx,
        "linear_write",
        `unknown op '${op}' (use create|comment)`
      );
  }
}

/**
 * One-shot start-work: read a Linear card and check out the git branch Linear made
 * for it (created from the current branch if absent). Gated by the `linear`
 * capability; classified vcs_write (it mutates the working tree). Never throws.
 */
export async function doLinearStart(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  if (ctx.linear !== true || deps.registry === undefined) {
    return reject(ctx, "linear_start", CAPABILITY_OFF);
  }

  const id = str(args, "id");

  if (id.trim().length === 0) {
    return reject(ctx, "linear_start", "needs an issue `id` (e.g. ENG-123)");
  }

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_start ${id}` });

  const res = await callLinear(deps.registry, ["get_issue"], { id });

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);
  const branch = rec === null ? "" : branchOf(rec);

  if (branch.length === 0) {
    return `linear_start: ${id} has no branch name from Linear — create the branch yourself with git_write`;
  }

  if (unsafe(branch)) {
    return reject(ctx, "linear_start", `unsafe branch name '${branch}'`);
  }

  const signalOpt = ctx.signal === undefined ? {} : { signal: ctx.signal };
  // Switch to the branch; if it doesn't exist yet, create it from HEAD.
  let sw = await deps.run(ctx.cwd, ["git", "switch", branch], signalOpt);

  if (sw.exitCode === 127) {
    return "linear_start: git is not installed or not on PATH";
  }

  if (sw.exitCode !== 0) {
    sw = await deps.run(ctx.cwd, ["git", "switch", "-c", branch], signalOpt);
  }

  if (sw.exitCode !== 0) {
    return `linear_start: could not check out '${branch}':\n${pick(sw.stderr, sw.stdout).slice(0, 400)}`;
  }

  const title = rec === null ? "" : field(rec, "title", "name");

  return `on branch ${branch} for ${id}${title.length > 0 ? ` — ${title}` : ""}. Open a PR referencing ${id} when done; Linear moves the card automatically.`;
}
