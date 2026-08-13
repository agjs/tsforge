import type { IChatMessage, IProvider } from "../../inference/inference.types";

/** Cap user turn text fed to the extractor. */
export const EXTRACT_USER_CAP = 2000;

/** Cap assistant turn text fed to the extractor. */
export const EXTRACT_ASSISTANT_CAP = 4000;

/** Bound the extract LLM call so a hung model cannot pile work up. */
export const EXTRACT_DECISION_TIMEOUT_MS = 8000;

/** Hard cap on decisions retained from one green turn. */
export const MAX_DECISIONS_PER_TURN = 5;

/** Soft cap on a single retained decision line. */
const MAX_DECISION_CHARS = 400;

/**
 * System prompt for post-green decision extraction.
 *
 * The bank is for durable product/architecture choices only — not harness
 * chatter, plan approvals, debugging, or one-off task asks.
 */
export const EXTRACT_DECISIONS_SYSTEM = [
  "Extract durable PRODUCT and ARCHITECTURE decisions from this coding turn.",
  "A decision is a lasting preference about how this codebase should be built",
  "(e.g. UI patterns, data model rules, gate policy, naming, stack choices).",
  "",
  "Return ONLY a JSON array of short strings. Examples:",
  '["Company FK is a native <select>, not a combobox"]',
  "[]",
  "",
  "Return [] when there are NO durable decisions. Always return [] for:",
  "- plan approvals / checklist / task_list / worklist chatter",
  '- harness or memory debugging ("why isn\'t memory working")',
  "- connectivity probes / test retains",
  "- one-off task requests with no lasting product rule",
  "- tool usage instructions or session mode toggles",
  "",
  "Do not invent decisions. Do not include secrets. Max 5 items.",
].join("\n");

/** Trim and hard-cap a turn fragment. */
export function capExtractText(text: string, max: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function isNoneToken(line: string): boolean {
  const t = line.trim().toLowerCase();

  return (
    t.length === 0 ||
    t === "none" ||
    t === "[]" ||
    t === "null" ||
    t === "no decisions" ||
    t === "no durable decisions"
  );
}

function normalizeDecision(raw: string): string | null {
  let line = raw.trim();

  // Strip common list / JSON string chrome.
  if (line.startsWith("- ") || line.startsWith("* ")) {
    line = line.slice(2).trim();
  }

  if (
    (line.startsWith('"') && line.endsWith('"')) ||
    (line.startsWith("'") && line.endsWith("'"))
  ) {
    line = line.slice(1, -1).trim();
  }

  if (line.endsWith(",")) {
    line = line.slice(0, -1).trim();
  }

  if (isNoneToken(line) || line.length < 8) {
    return null;
  }

  if (line.length > MAX_DECISION_CHARS) {
    line = `${line.slice(0, MAX_DECISION_CHARS - 1).trimEnd()}…`;
  }

  return line;
}

function uniqueDecisions(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const key = item.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(item);

    if (out.length >= MAX_DECISIONS_PER_TURN) {
      break;
    }
  }

  return out;
}

function decisionsFromJsonArray(parsed: unknown): readonly string[] | null {
  if (!Array.isArray(parsed)) {
    return null;
  }

  const fromJson: string[] = [];

  for (const item of parsed) {
    if (typeof item !== "string") {
      continue;
    }

    const n = normalizeDecision(item);

    if (n !== null) {
      fromJson.push(n);
    }
  }

  return uniqueDecisions(fromJson);
}

function tryParseJsonDecisions(trimmed: string): readonly string[] | null {
  const jsonStart = trimmed.indexOf("[");
  const jsonEnd = trimmed.lastIndexOf("]");

  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));

    return decisionsFromJsonArray(parsed);
  } catch {
    return null;
  }
}

function decisionsFromLines(trimmed: string): readonly string[] {
  const fromLines: string[] = [];

  for (const line of trimmed.split("\n")) {
    const n = normalizeDecision(line);

    if (n !== null) {
      fromLines.push(n);
    }
  }

  return uniqueDecisions(fromLines);
}

/**
 * Parse model output into decision strings. Accepts a JSON string array or
 * simple line/bullet lists. Junk / NONE → [].
 */
export function parseExtractedDecisions(raw: string): readonly string[] {
  const trimmed = raw.trim();

  if (isNoneToken(trimmed)) {
    return [];
  }

  // Prefer a JSON array anywhere in the reply (models often wrap with prose).
  return tryParseJsonDecisions(trimmed) ?? decisionsFromLines(trimmed);
}

/** Walk messages backward for the latest non-empty assistant content. */
export function lastAssistantContent(
  messages: readonly IChatMessage[]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg?.role !== "assistant") {
      continue;
    }

    const content = msg.content.trim();

    if (content.length > 0) {
      return content;
    }
  }

  return "";
}

/**
 * Ask the session model for durable product/architecture decisions in this
 * turn. Fail-soft callers should wrap with a deadline.
 */
export async function extractDecisions(
  provider: IProvider,
  userText: string,
  assistantText: string,
  opts?: { readonly signal?: AbortSignal }
): Promise<readonly string[]> {
  const user = capExtractText(userText, EXTRACT_USER_CAP);
  const assistant = capExtractText(assistantText, EXTRACT_ASSISTANT_CAP);

  if (user.length === 0 && assistant.length === 0) {
    return [];
  }

  const transcript = [
    user.length > 0 ? `[user]\n${user}` : null,
    assistant.length > 0 ? `[assistant]\n${assistant}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");

  const res = await provider.complete(
    [
      { role: "system", content: EXTRACT_DECISIONS_SYSTEM },
      { role: "user", content: transcript },
    ],
    {
      temperature: 0,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    }
  );

  return parseExtractedDecisions(res.content);
}
