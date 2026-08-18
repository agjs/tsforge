/**
 * Last-resort transcript digest for a subagent that ended without a final
 * answer (turn cap, abort, provider error). Before this existed, those paths
 * returned only the agent's last prose fragment — usually empty for a
 * tool-calling investigator — so ten turns of findings were silently discarded
 * and the orchestrator received a bare status tag. The digest is mechanical
 * (no model call): it can run after an abort or a dead provider.
 */
import type { IChatMessage } from "../inference";

/** Exact prefix compactAgentMessages writes (agent-runner.ts) — after an
 *  auto-compaction these summaries ARE the investigation so far. */
const COMPACTION_PREFIX = "[Summary of the investigation so far]";

const MAX_SUMMARY_CHARS = 800;
const MAX_PROSE_FRAGMENTS = 6;
const MAX_PROSE_CHARS = 500;
const MAX_TOOL_PREVIEWS = 4;
const MAX_TOOL_PREVIEW_CHARS = 300;
const MAX_DIGEST_CHARS = 4_000;

/** What callers show when even the digest comes back empty — the orchestrator
 *  must never receive a bare status tag with nothing after it. */
export const NO_SALVAGE_FALLBACK =
  "(no salvageable output: the agent produced no prose or tool results)";

/** The digest, or the fixed fallback when the transcript held nothing. */
export function salvageOrFallback(messages: readonly IChatMessage[]): string {
  const digest = buildSalvageDigest(messages);

  return digest.length > 0 ? digest : NO_SALVAGE_FALLBACK;
}

function cap(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Trim to the digest budget without splitting a UTF-16 surrogate pair. */
function capDigest(text: string): string {
  if (text.length <= MAX_DIGEST_CHARS) {
    return text;
  }

  const sliced = text.slice(0, MAX_DIGEST_CHARS);
  const lastCharCode = sliced.charCodeAt(sliced.length - 1);

  return lastCharCode >= 0xd800 && lastCharCode <= 0xdbff
    ? sliced.slice(0, -1)
    : sliced;
}

/** toolCallId → tool name, from the assistant turns that made the calls. */
function toolNamesById(messages: readonly IChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();

  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      if (call.id !== undefined) {
        names.set(call.id, call.name);
      }
    }
  }

  return names;
}

/**
 * Digest a subagent transcript into the most useful remains: compaction
 * summaries (the condensed investigation), the last few assistant prose
 * fragments (the agent's own conclusions-in-progress), and the last few tool
 * results (the freshest evidence). Returns "" when the transcript holds
 * nothing salvageable — callers substitute {@link NO_SALVAGE_FALLBACK}.
 */
export function buildSalvageDigest(messages: readonly IChatMessage[]): string {
  const names = toolNamesById(messages);

  const summaries = messages
    .filter((m) => m.role === "user" && m.content.startsWith(COMPACTION_PREFIX))
    .map((m) => cap(m.content, MAX_SUMMARY_CHARS));

  const prose = messages
    .filter((m) => m.role === "assistant" && m.content.trim().length > 0)
    .map((m) => cap(m.content.trim(), MAX_PROSE_CHARS))
    .slice(-MAX_PROSE_FRAGMENTS);

  // The runner injects its own `agent_result` reject as a tool message — that
  // is coaching, not evidence; keep only real tool output.
  const toolPreviews = messages
    .filter((m) => {
      if (m.role !== "tool") {
        return false;
      }

      const name = m.toolCallId === undefined ? "" : names.get(m.toolCallId);

      return name !== undefined && name !== "" && name !== "agent_result";
    })
    .slice(-MAX_TOOL_PREVIEWS)
    .map((m) => {
      const name =
        m.toolCallId === undefined
          ? "tool"
          : (names.get(m.toolCallId) ?? "tool");

      return `[${name}] ${cap(m.content.trim(), MAX_TOOL_PREVIEW_CHARS)}`;
    });

  const sections = [...summaries, ...prose, ...toolPreviews];

  if (sections.length === 0) {
    return "";
  }

  return capDigest(
    [
      "Transcript digest (the agent hit its limit before producing a final answer):",
      ...sections,
    ].join("\n")
  );
}
