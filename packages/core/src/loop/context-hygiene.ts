/**
 * Context-pollution controls: one live gate-feedback slot, redact applied
 * create/edit bodies, and evict stale read / write-guard residue.
 */
import type { IChatMessage, IProvider } from "../inference";
import { TOOL_NAME } from "../agent/agent.constants";
import { COMPACT_SYSTEM } from "./prompt";
import { isGateFeedbackInject } from "./harness-inject";

/**
 * Max unique file paths that keep a live `read` dump in history. Oldest paths
 * beyond this are stubbed for size — never because "N assistant turns passed"
 * (that trap ordered re-reads and deadlocked Shiphold).
 */
export const MAX_LIVE_READ_PATHS = 12;

/**
 * How many later assistant turns before create/edit arg bodies are redacted.
 * Keep the real body for the next turn, then collapse to file + omit flag
 * (never `contentMeta` — models re-submit that as the create schema).
 */
export const STALE_WRITE_ASSISTANT_TURNS = 1;

/** True when a string is (or contains) a harness history marker — never source. */
export function looksLikeHarnessOmitMarker(text: string): boolean {
  return (
    text.includes("harness:content-omitted") ||
    text.includes("harness:read-omitted") ||
    text.includes("[applied; on disk") ||
    text.includes("THIS IS NOT FILE CONTENTS") ||
    text.includes("NOT file contents")
  );
}

function normalizeReadPath(file: string | undefined): string {
  return (file ?? "file").replaceAll("\\", "/");
}

function readOmitStub(path: string, reason: "superseded" | "budget"): string {
  if (reason === "superseded") {
    return (
      `<harness:read-omitted path="${path}" — NOT file contents; ` +
      `superseded by a later read of this path — do NOT call read again; ` +
      `use the live copy still in history or proceed to create/edit.>`
    );
  }

  return (
    `<harness:read-omitted path="${path}" — NOT file contents; ` +
    `dropped for context size — do NOT call read again; ` +
    `write using live copies still in history or proceed to create/edit.>`
  );
}

const WRITE_GUARD_MARKERS: readonly string[] = [
  "\n\n⚠ CHECK of this file",
  "\n\n⚠ BLAST RADIUS",
  "\n\n⚠ STRUCTURE check",
  "\n\nℹ ",
];

/** Replace-or-append the single live settle gate-feedback user message. */
export function upsertGateFeedback(
  messages: IChatMessage[],
  content: string
): void {
  const next: IChatMessage = { role: "user", content };
  let kept = -1;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];

    if (m === undefined || !isGateFeedbackInject(m)) {
      continue;
    }

    if (kept < 0) {
      messages[i] = next;
      kept = i;
    } else {
      messages.splice(i, 1);
      kept -= 1;
    }
  }

  if (kept < 0) {
    messages.push(next);
  }
}

/**
 * History-only flag on redacted create/edit toolCall args. Must NOT resemble a
 * schema field (`contentMeta` taught DeepSeek to re-submit create without
 * `content` — dozens of tool_input_rejected:create in one Shiphold run).
 */
export const HARNESS_ARGS_OMITTED = "_harnessArgsOmitted";

/** True when args look like a re-submitted history stub, not a real write. */
export function hasHarnessOmittedArgs(args: Record<string, unknown>): boolean {
  const omit = args[HARNESS_ARGS_OMITTED];

  return (
    omit === true ||
    omit === "true" ||
    args.contentMeta !== undefined ||
    args.oldStringMeta !== undefined ||
    args.newStringMeta !== undefined
  );
}

/**
 * Outbound wire projection for create/edit args. In-memory history keeps the
 * omit flag for reject detection; the model must NEVER see `_harnessArgsOmitted`
 * (Ledgerkit: ~80 dead turns copying that token). Stubs go out as `{file}` only.
 */
export function projectWriteArgsForWire(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (toolName !== TOOL_NAME.create && toolName !== TOOL_NAME.edit) {
    return args;
  }

  if (!hasHarnessOmittedArgs(args)) {
    return args;
  }

  const file = typeof args.file === "string" ? args.file : undefined;

  return file === undefined ? {} : { file };
}

/**
 * True when peeled create/edit args have no real write payload — file-only
 * (or empty) copies of a wire-scrubbed stub. Same reject family as omit-flag.
 */
export function isIncompleteWriteStub(args: Record<string, unknown>): boolean {
  if (hasHarnessOmittedArgs(args)) {
    return true;
  }

  const keys = Object.keys(args);

  if (keys.length === 0) {
    return true;
  }

  const fileKeys = new Set([
    "file",
    "path",
    "filename",
    "filepath",
    "filePath",
  ]);

  return keys.every((k) => fileKeys.has(k));
}

/** Tool-result text from create/edit:history-meta rejects. */
export function isHistoryMetaRejectContent(content: string): boolean {
  return content.includes("harness history stub");
}

function stubFileOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [HARNESS_ARGS_OMITTED]: true,
  };
  const file = typeof args.file === "string" ? args.file : undefined;

  if (file !== undefined) {
    out.file = file;
  }

  return out;
}

function stubEditArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Drop oldString/newString/edits entirely — meta siblings were re-submitted.
  return stubFileOnly(args);
}

function stubCreateArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  return stubFileOnly(args);
}

/**
 * Rewrite legacy `contentMeta` / `*StringMeta` stubs left in persisted history
 * (pre-fix redaction). `--continue` was replaying those and the model copied
 * them as create/edit args forever.
 */
export function scrubLegacyWriteArgStubs(messages: IChatMessage[]): number {
  let n = 0;

  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCalls === undefined) {
      continue;
    }

    for (const tc of m.toolCalls) {
      if (tc.name !== TOOL_NAME.create && tc.name !== TOOL_NAME.edit) {
        continue;
      }

      if (!hasHarnessOmittedArgs(tc.arguments)) {
        continue;
      }

      // Already the safe shape.
      if (
        tc.arguments[HARNESS_ARGS_OMITTED] === true &&
        tc.arguments.contentMeta === undefined &&
        tc.arguments.oldStringMeta === undefined &&
        tc.arguments.newStringMeta === undefined &&
        tc.arguments.content === undefined &&
        tc.arguments.oldString === undefined &&
        tc.arguments.newString === undefined &&
        tc.arguments.edits === undefined
      ) {
        continue;
      }

      tc.arguments = stubFileOnly(tc.arguments);
      n += 1;
    }
  }

  return n;
}

function callMeta(
  messages: readonly IChatMessage[]
): Map<string, { name: string; file?: string }> {
  const meta = new Map<string, { name: string; file?: string }>();

  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCalls === undefined) {
      continue;
    }

    m.toolCalls.forEach((tc, ti) => {
      const id = tc.id ?? `call_${String(ti)}`;
      const file =
        typeof tc.arguments.file === "string" ? tc.arguments.file : undefined;

      meta.set(
        id,
        file === undefined ? { name: tc.name } : { name: tc.name, file }
      );
    });
  }

  return meta;
}

function hasLaterGateFeedback(
  messages: readonly IChatMessage[],
  fromIndex: number
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i += 1) {
    const m = messages[i];

    if (m !== undefined && isGateFeedbackInject(m)) {
      return true;
    }
  }

  return false;
}

function stripWriteGuardBlast(content: string): string {
  let cut = -1;

  for (const marker of WRITE_GUARD_MARKERS) {
    const idx = content.indexOf(marker);

    if (idx >= 0 && (cut < 0 || idx < cut)) {
      cut = idx;
    }
  }

  if (cut < 0) {
    return content;
  }

  const head = content.slice(0, cut).trimEnd();

  if (head.includes("[write-guard detail dropped")) {
    return content;
  }

  return `${head}\n\n[write-guard detail dropped — see latest gate feedback]`;
}

function ageWriteArgsOnAssistant(
  m: IChatMessage,
  assistantAfter: number
): void {
  if (
    assistantAfter < STALE_WRITE_ASSISTANT_TURNS ||
    m.toolCalls === undefined
  ) {
    return;
  }

  for (const tc of m.toolCalls) {
    if (tc.name === TOOL_NAME.create) {
      tc.arguments = stubCreateArgs(tc.arguments);
    } else if (tc.name === TOOL_NAME.edit) {
      tc.arguments = stubEditArgs(tc.arguments);
    }
  }
}

/** Supersede older same-path reads; record newest-first live indices. */
function pruneOneReadDump(
  m: IChatMessage,
  path: string,
  index: number,
  seenReadPaths: Set<string>,
  liveReadIndices: number[]
): void {
  if (seenReadPaths.has(path)) {
    m.content = readOmitStub(path, "superseded");

    return;
  }

  seenReadPaths.add(path);
  liveReadIndices.push(index);
}

/** Drop oldest unique live reads past MAX_LIVE_READ_PATHS (newest-first list). */
function trimLiveReadBudget(
  messages: IChatMessage[],
  meta: Map<string, { name: string; file?: string }>,
  liveReadIndices: readonly number[]
): void {
  for (let k = MAX_LIVE_READ_PATHS; k < liveReadIndices.length; k += 1) {
    const idx = liveReadIndices[k];

    if (idx === undefined) {
      continue;
    }

    const m = messages[idx];

    if (m?.role !== "tool" || m.toolCallId === undefined) {
      continue;
    }

    if (m.content.includes("harness:read-omitted")) {
      continue;
    }

    const info = meta.get(m.toolCallId);

    m.content = readOmitStub(normalizeReadPath(info?.file), "budget");
  }
}

/**
 * Evict superseded / over-budget `read` dumps, redact aged create/edit bodies,
 * and collapse write-guard appendices once a later settle gate-feedback exists.
 *
 * Reads: keep the latest live dump per path; omit older same-path dumps
 * (superseded). Cap unique live paths at MAX_LIVE_READ_PATHS. Never omit solely
 * because assistant turns passed, and never tell the model to re-read.
 */
export function pruneEphemeralToolResidue(messages: IChatMessage[]): void {
  scrubLegacyWriteArgStubs(messages);

  const meta = callMeta(messages);
  let assistantAfter = 0;
  const seenReadPaths = new Set<string>();
  /** Newest-first indices of live (kept) unique-path reads — for budget trim. */
  const liveReadIndices: number[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];

    if (m === undefined) {
      continue;
    }

    if (m.role === "assistant") {
      ageWriteArgsOnAssistant(m, assistantAfter);
      assistantAfter += 1;
      continue;
    }

    if (m.role !== "tool" || m.toolCallId === undefined) {
      continue;
    }

    const info = meta.get(m.toolCallId);

    if (
      info?.name === TOOL_NAME.read &&
      !m.content.includes("harness:read-omitted")
    ) {
      pruneOneReadDump(
        m,
        normalizeReadPath(info.file),
        i,
        seenReadPaths,
        liveReadIndices
      );
    }

    if (
      (info?.name === TOOL_NAME.create || info?.name === TOOL_NAME.edit) &&
      hasLaterGateFeedback(messages, i)
    ) {
      m.content = stripWriteGuardBlast(m.content);
    }
  }

  trimLiveReadBudget(messages, meta, liveReadIndices);
}

/** Percent full when over the auto-compact threshold; otherwise undefined. */
export function autoCompactPct(
  promptTokens: number,
  contextWindow: number,
  autoCompactAt: number
): number | undefined {
  if (contextWindow <= 0) {
    return undefined;
  }

  const fraction = promptTokens / contextWindow;

  return fraction >= autoCompactAt ? Math.round(fraction * 100) : undefined;
}

/**
 * Summarize the conversation into [system?, summary user], freeing context.
 * Shared by interactive Session and headless runTask.
 */
export async function compactConversation(
  messages: IChatMessage[],
  provider: IProvider,
  signal?: AbortSignal
): Promise<{ before: number; after: number; messages: IChatMessage[] }> {
  const before = messages.length;
  const conversation = messages.filter((m) => m.role !== "system");

  if (conversation.length === 0) {
    return { before, after: before, messages };
  }

  const transcript = conversation
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");
  const res = await provider.complete(
    [
      { role: "system", content: COMPACT_SYSTEM },
      { role: "user", content: transcript },
    ],
    { temperature: 0, ...(signal === undefined ? {} : { signal }) }
  );

  const system = messages[0];
  const summary: IChatMessage = {
    role: "user",
    content: `[Summary of the earlier conversation]\n${res.content}`,
  };
  const next: IChatMessage[] =
    system?.role === "system" ? [system, summary] : [summary];

  return { before, after: next.length, messages: next };
}
