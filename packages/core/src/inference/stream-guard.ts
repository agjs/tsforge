import type { TokenChannel } from "./inference.types";

/**
 * Detects the degenerate repetition loops this local model falls into at
 * temperature 0 — where it spews the same line (or a fixed template like
 * "I will ensure it is X.") until it hits max_tokens, never emitting a tool
 * call. The repetition penalty makes this rare; this guard makes it IMPOSSIBLE
 * to hang the CLI: the stream is aborted the moment a loop is detected, instead
 * of burning a full 16k-token generation (and then a nudge, and another loop).
 *
 * Watches the prose channels only (reasoning + content) — file content is
 * carried in tool-call ARGUMENTS, never here, so code can't false-positive.
 * Thresholds are deliberately high: real narration never repeats one short line
 * 24 times, nor shares a 4-word prefix across 20 of 24 consecutive lines.
 *
 * The sliding-window checks only see repetition whose PERIOD fits inside WINDOW.
 * A model that re-prints a large block (e.g. a ~30-line function + paragraphs of
 * "wait, I think I see the issue…") loops with a period far bigger than 24, so
 * every window slice looks distinct and they miss it entirely. The period-
 * AGNOSTIC counter below catches that: any one long line emitted many times
 * across the whole generation is a loop no matter how big the repeating block.
 */
const WINDOW = 24;
/** Ignore trivial lines (blanks, lone braces, indentation) — only substantial
 *  lines count toward a loop. */
const MIN_LINE_LEN = 6;
/** ≤ this many distinct lines across the window ⇒ near-exact repetition. */
const MAX_DISTINCT = 3;
/** ≥ this many lines sharing a 4-word prefix ⇒ templated repetition. */
const PREFIX_MATCH = 12;
const PREFIX_WORDS = 4;
/** A line this long, repeated verbatim `GLOBAL_REPEAT_LIMIT` times anywhere in
 *  the stream, is a loop — long lines don't recur exactly in real prose/code. */
const LONG_LINE_LEN = 20;
/** Was 5 — local models often stutter the same "Let me check…" line 3–4 times
 *  before a tool call; trip earlier so the CLI doesn't paint a wall of repeats.
 *  Applies to the REASONING channel, where the stutter lives. */
const GLOBAL_REPEAT_LIMIT = 3;
/** The CONTENT channel gets more headroom: a real answer legitimately repeats a
 *  line (quote it, show it fixed, mention it in the summary) without looping —
 *  at 3, normal answers were aborted as degenerate. Code inside fences is
 *  exempted entirely below; this bound covers repeated PROSE lines. */
const CONTENT_REPEAT_LIMIT = 5;

/** Markers that the model has started emitting STRUCTURED tool calls into the
 *  content channel — a server tool-call-parser mismatch (e.g. atlas-spark's
 *  Qwen3.5-native `<function=…>` XML, which Atlas's parsers don't match) leaves
 *  them in `content` instead of `tool_calls`. Once seen, content is no longer
 *  prose, so the prose-loop guard must stand down for it (the leaked calls are
 *  salvaged + deduped downstream). */
const TOOL_MARKUP_RE = /<function=|<tool_call>/i;

type ProseChannel = "reasoning" | "content";

export class StreamGuard {
  private readonly lines: Record<ProseChannel, string[]> = {
    reasoning: [],
    content: [],
  };
  private readonly partial: Record<ProseChannel, string> = {
    reasoning: "",
    content: "",
  };
  /** Per-channel count of every substantial line seen across the WHOLE stream —
   *  backs the period-agnostic large-block loop check. */
  private readonly counts: Record<ProseChannel, Map<string, number>> = {
    reasoning: new Map(),
    content: new Map(),
  };
  /** Set once tool-call markup leaks into the content channel — thereafter the
   *  prose-loop guard stands down for content (see TOOL_MARKUP_RE). */
  private contentIsToolMarkup = false;
  /** True while the content channel is inside a ``` fence. Fenced CODE
   *  legitimately repeats lines (imports, `return null;`, table rows) that the
   *  prose thresholds would abort as degenerate — a real answer containing a
   *  code block must not be killed mid-stream. Fenced lines are drained but
   *  never counted. Reasoning is unaffected (its loops are prose stutter). */
  private contentFenceOpen = false;

  /** Feed a streamed token; returns true once the channel has degenerated. Only
   *  the prose channels are watched — tool-call output is structured, not a loop
   *  we'd abort. */
  observe(text: string, channel: TokenChannel): boolean {
    if (channel === "tool") {
      return false;
    }

    this.partial[channel] += text;

    if (
      channel === "content" &&
      !this.contentIsToolMarkup &&
      TOOL_MARKUP_RE.test(this.partial.content)
    ) {
      this.contentIsToolMarkup = true;
    }

    const segments = this.partial[channel].split("\n");

    this.partial[channel] = segments.pop() ?? "";

    // Content has become leaked tool-call markup, not prose — drain the buffer
    // (so it stays bounded) but don't run the prose-loop checks on it.
    if (channel === "content" && this.contentIsToolMarkup) {
      return false;
    }

    for (const segment of segments) {
      if (this.lineDegenerates(segment.trim(), channel)) {
        return true;
      }
    }

    return false;
  }

  /** One completed line's contribution to the loop checks. Fence markers toggle
   *  the content fence; fenced content lines are drained but never counted. */
  private lineDegenerates(trimmed: string, channel: ProseChannel): boolean {
    if (channel === "content" && trimmed.startsWith("```")) {
      this.contentFenceOpen = !this.contentFenceOpen;

      return false;
    }

    if (channel === "content" && this.contentFenceOpen) {
      return false;
    }

    if (trimmed.length < MIN_LINE_LEN) {
      return false;
    }

    // Period-agnostic: a long line repeated many times anywhere in the stream
    // is a loop even when the repeating BLOCK is larger than WINDOW (which the
    // sliding-window checks below would miss).
    if (
      trimmed.length >= LONG_LINE_LEN &&
      this.longLineLooped(trimmed, channel)
    ) {
      return true;
    }

    const window = this.lines[channel];

    window.push(trimmed);

    if (window.length > WINDOW) {
      window.shift();
    }

    return window.length === WINDOW && isRepetitive(window);
  }

  /** The whole-stream exact-repeat counter for substantial lines. */
  private longLineLooped(trimmed: string, channel: ProseChannel): boolean {
    const counts = this.counts[channel];
    const seen = (counts.get(trimmed) ?? 0) + 1;
    const limit =
      channel === "content" ? CONTENT_REPEAT_LIMIT : GLOBAL_REPEAT_LIMIT;

    counts.set(trimmed, seen);

    return seen >= limit;
  }
}

function isRepetitive(window: string[]): boolean {
  const distinct = new Set(window).size;

  if (distinct <= MAX_DISTINCT) {
    return true;
  }

  // Block repetition: the model loops a multi-line block (e.g. re-printing the
  // same "cat X / npx tsc / echo …" sequence). The lines vary within the block,
  // so the exact-line check above misses it — but half-or-more of the window
  // being duplicates is a loop no real prose produces.
  if (distinct <= Math.floor(WINDOW / 2)) {
    return true;
  }

  const prefixCounts = new Map<string, number>();

  for (const line of window) {
    const prefix = line.split(/\s+/).slice(0, PREFIX_WORDS).join(" ");
    const next = (prefixCounts.get(prefix) ?? 0) + 1;

    prefixCounts.set(prefix, next);

    if (next >= PREFIX_MATCH) {
      return true;
    }
  }

  return false;
}
