import type {
  IModelResponse,
  IToolCall,
  ITokenUsage,
  ITtsrWatcher,
  TokenChannel,
} from "./inference.types";
import { ModelRequestError } from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import {
  parseArgs,
  parseUsage,
  salvageToolCalls,
  salvageFusedToolName,
} from "./wire";
import { StreamGuard } from "./stream-guard";

/** Keep in sync with `toolGlyph` in render/box — no import (avoids inference↔render). */
const STREAM_TOOL_GLYPH: Readonly<Record<string, string>> = {
  read: "◎",
  search: "⌕",
  symbol_search: "⌕",
  find_references: "⌕",
  run: "→",
  script: "→",
  create: "✚",
  scaffold_ui: "✚",
  edit: "✎",
  edit_lines: "✎",
};

function streamToolGlyph(name: string): string {
  return STREAM_TOOL_GLYPH[name] ?? "●";
}

interface IStreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: unknown;
  usage?: ITokenUsage;
}

/** Streaming: parse SSE chunks, forward tokens to `onToken`, assemble the response.
 *  When ttsrManager is provided, feeds deltas to it and aborts on rule match. */
export async function streamResponse(
  res: Response,
  onToken: (text: string, channel: TokenChannel) => void,
  ttsrManager?: ITtsrWatcher
): Promise<IModelResponse> {
  const body = res.body;

  if (body === null) {
    return { content: "", toolCalls: [] };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const acc: IStreamAcc = {
    calls: new Map(),
    guard: new StreamGuard(),
    content: "",
    reasoning: "",
    ttsr: ttsrManager,
    ttsrFired: null,
  };
  // `usage` arrives in a trailing chunk (choices: []), captured in consumeLines.
  let buffer = "";
  let degenerated = false;
  let result = await reader.read();

  while (!result.done) {
    buffer += decoder.decode(result.value, { stream: true });

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    degenerated = consumeLines(lines, acc, onToken);

    if (degenerated || acc.ttsrFired !== null) {
      // Stop the runaway generation instead of letting it spew to max_tokens,
      // or abort when TTSR fires to inject corrective guidance.
      await reader.cancel();

      break;
    }

    result = await reader.read();
  }

  buffer += decoder.decode();

  if (!degenerated && buffer.trim().length > 0) {
    degenerated = consumeLines([buffer], acc, onToken);
  }

  return assemble(acc, degenerated);
}

/** One in-flight tool call being assembled from streamed deltas. The `path`/
 *  `lastProgress` fields drive the live progress heartbeat (responsiveness). */
interface IStreamingCall {
  id?: string;
  name: string;
  args: string;
  /** True once we've surfaced the file path parsed from the partial args. */
  pathShown?: boolean;
  /** args length at the last progress heartbeat (throttle). */
  lastProgress?: number;
  /** File path latched from the partial args ONCE — re-running the extraction
   *  regex over the whole accumulated args on every delta was O(n²) per file
   *  write (~200M char-scans for a 40KB create). The path sits in the first
   *  bytes of the JSON and never changes. */
  extractedPath?: string;
}

interface IStreamAcc {
  calls: Map<number, IStreamingCall>;
  guard: StreamGuard;
  content: string;
  reasoning: string;
  usage?: ITokenUsage;
  ttsr?: ITtsrWatcher;
  ttsrFired: { readonly name: string; readonly guidance: string } | null;
}

/** Forward a content delta, watching for degeneration and TTSR matches.
 *  Returns true when the stream should stop. */
function consumeContentDelta(
  text: string,
  acc: IStreamAcc,
  onToken: (text: string, channel: TokenChannel) => void
): boolean {
  acc.content += text;
  onToken(text, "content");

  if (acc.guard.observe(text, "content")) {
    return true;
  }

  if (acc.ttsr !== undefined && acc.ttsrFired === null) {
    acc.ttsrFired = acc.ttsr.checkDelta(text, { source: "content" });

    if (acc.ttsrFired !== null) {
      return true;
    }
  }

  return false;
}

/** Parse a batch of SSE lines, forward tokens, accumulate state; returns true
 *  the moment the model's output degenerates into a repetition loop. */
function consumeLines(
  lines: string[],
  acc: IStreamAcc,
  onToken: (text: string, channel: TokenChannel) => void
): boolean {
  for (const line of lines) {
    const delta = parseSseLine(line);

    if (delta === null) {
      continue;
    }

    // Forward reasoning too — the log is the full record of what happened.
    // (The "too much output" problem is solved by making the model think
    // less, not by hiding it from the log.)
    if (delta.reasoning !== undefined && delta.reasoning.length > 0) {
      onToken(delta.reasoning, "reasoning");
      acc.reasoning += delta.reasoning;

      if (acc.guard.observe(delta.reasoning, "reasoning")) {
        return true;
      }
    }

    if (
      delta.content !== undefined &&
      delta.content.length > 0 &&
      consumeContentDelta(delta.content, acc, onToken)
    ) {
      return true;
    }

    if (delta.usage !== undefined) {
      acc.usage = delta.usage;
    }

    accumulateToolCalls(delta.toolCalls, acc.calls, onToken, acc);
  }

  return false;
}

function assemble(acc: IStreamAcc, degenerated: boolean): IModelResponse {
  const usage = acc.usage === undefined ? {} : { usage: acc.usage };
  const reasoning =
    acc.reasoning.length > 0 ? { reasoning: acc.reasoning } : {};
  const toolCalls: IToolCall[] = [...acc.calls.values()].map((c) => {
    // Rescue a structured call whose `name` absorbed the XML body (qwen emitted a
    // bare `edit<parameter=file>…` the server couldn't split) — otherwise the
    // garbage name hits the policy as an "unknown tool" and the model loops on it.
    const fused = salvageFusedToolName(c.name, c.args);

    return fused === null
      ? { id: c.id, name: c.name, arguments: parseArgs(c.args) }
      : { id: c.id, name: fused.name, arguments: fused.arguments };
  });

  const ttsrFired =
    acc.ttsrFired !== null
      ? {
          ttsrFired: {
            ruleName: acc.ttsrFired.name,
            guidance: acc.ttsrFired.guidance,
          },
        }
      : {};

  if (toolCalls.length > 0) {
    return degenerated
      ? {
          content: acc.content,
          toolCalls,
          degenerated,
          ...reasoning,
          ...ttsrFired,
          ...usage,
        }
      : {
          content: acc.content,
          toolCalls,
          ...reasoning,
          ...ttsrFired,
          ...usage,
        };
  }

  const salvaged = salvageToolCalls(acc.content);

  return {
    content: acc.content,
    toolCalls: salvaged,
    salvaged: salvaged.length,
    ...(degenerated ? { degenerated } : {}),
    ...reasoning,
    ...ttsrFired,
    ...usage,
  };
}

/** Raise a stream-borne error, preserving the server's own status code so a
 *  caller can tell a permanent rejection from a transient one. */
function throwIfStreamError(parsed: Record<string, unknown>): void {
  const error = parsed.error;

  if (!isRecord(error)) {
    return;
  }

  const message =
    typeof error.message === "string" ? error.message : JSON.stringify(error);
  const status = typeof error.code === "number" ? error.code : 502;

  throw new ModelRequestError(status, message);
}

function parseSseLine(line: string): IStreamDelta | null {
  const trimmed = line.trim();

  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice(5).trim();

  if (payload === "[DONE]" || payload.length === 0) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  // An SSE stream can carry a SERVER ERROR with a 200 status: vLLM answers a
  // rejected parameter with `data: {"error": {...}}` and then `[DONE]`.
  // Ignoring it produced the worst possible outcome — an empty completion that
  // reads as "the model chose to say nothing", so the loop retried the same
  // doomed request for its whole turn budget and the task failed as if the
  // model could not do the work. Every such error must surface as an error.
  throwIfStreamError(parsed);

  // The trailing usage chunk has an empty `choices` array — capture its usage
  // even though there's no delta to forward.
  const usage = parseUsage(parsed.usage);
  const choices = parsed.choices;
  const first = isArray(choices) ? choices[0] : undefined;

  if (!isRecord(first) || !isRecord(first.delta)) {
    return usage === undefined ? null : { usage };
  }

  const delta = first.delta;

  return {
    content: typeof delta.content === "string" ? delta.content : undefined,
    reasoning: firstString(delta.reasoning, delta.reasoning_content),
    toolCalls: delta.tool_calls,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Tools whose argument IS a large file body — worth a live progress heartbeat
 *  (for a 20 tok/s model, minutes of silent arg streaming is the worst UX). */
const BIG_CONTENT_TOOLS = new Set(["create", "edit", "scaffold_ui"]);
/** Chars of args between progress heartbeats. */
const PROGRESS_EVERY = 1500;

/**
 * Surface live progress as a big-content tool's arguments stream: the file path
 * (parsed from the partial args JSON) the moment it's known, then a throttled size
 * heartbeat. Turns minutes of silent generation into "writing X.tsx … 2.9KB …".
 */
function emitToolProgress(
  call: IStreamingCall,
  onToken: (text: string, channel: TokenChannel) => void
): void {
  if (!BIG_CONTENT_TOOLS.has(call.name)) {
    return;
  }

  // Same bound as the TTSR latch: a pathless args body (or one where the path
  // key never comes) must not be re-scanned in full on every delta forever.
  if (call.pathShown !== true && call.args.length <= MAX_PATH_SCAN_CHARS) {
    const path = /"(?:file|filename|path)"\s*:\s*"([^"]+)"/.exec(
      call.args
    )?.[1];

    if (path !== undefined) {
      call.pathShown = true;
      onToken(`\n  ${streamToolGlyph(call.name)} → ${path}`, "tool");
    }
  }

  if (call.args.length - (call.lastProgress ?? 0) >= PROGRESS_EVERY) {
    call.lastProgress = call.args.length;
    onToken(
      `\n  ⋯ ${(call.args.length / 1024).toFixed(1)}KB streamed…`,
      "tool"
    );
  }
}

const TTSR_WATCHED_TOOLS = new Set(["edit", "edit_lines", "create"]);

function accumulateToolCalls(
  raw: unknown,
  calls: Map<number, IStreamingCall>,
  onToken: (text: string, channel: TokenChannel) => void,
  acc?: IStreamAcc
): void {
  if (!isArray(raw)) {
    return;
  }

  for (const tc of raw) {
    if (!isRecord(tc) || !isRecord(tc.function)) {
      continue;
    }

    const index = typeof tc.index === "number" ? tc.index : 0;
    const existing: IStreamingCall = calls.get(index) ?? { name: "", args: "" };

    if (typeof tc.id === "string" && tc.id.length > 0) {
      existing.id = tc.id;
    }

    processToolCallDelta(tc.function, existing, onToken, acc);
    calls.set(index, existing);
  }
}

function processToolCallDelta(
  fn: Record<string, unknown>,
  existing: IStreamingCall,
  onToken: (text: string, channel: TokenChannel) => void,
  acc?: IStreamAcc
): void {
  // Surface the tool name the moment it first appears — so a long tool-call
  // generation shows "it's writing X now" instead of a frozen cursor. As the
  // (often large) file body then streams, emitToolProgress adds the path + a
  // throttled size heartbeat; the file lands as a clean create/edit event on run.
  if (typeof fn.name === "string" && fn.name.length > 0) {
    if (existing.name.length === 0) {
      onToken(`\n  ${streamToolGlyph(fn.name)} ${fn.name}…`, "tool");
    }

    existing.name = fn.name;
  }

  if (typeof fn.arguments !== "string" || fn.arguments.length === 0) {
    return;
  }

  existing.args += fn.arguments;
  emitToolProgress(existing, onToken);

  // TTSR on the tool-args channel. Gate by the ACCUMULATED tool name — the
  // name only arrives on a call's first delta, but every fragment must be fed.
  if (
    acc?.ttsr !== undefined &&
    acc.ttsrFired === null &&
    TTSR_WATCHED_TOOLS.has(existing.name)
  ) {
    // Latch the path once (mirrors pathShown): scan only until found, and stop
    // trying once the args have grown past where a path key could still start.
    if (
      existing.extractedPath === undefined &&
      existing.args.length <= MAX_PATH_SCAN_CHARS
    ) {
      existing.extractedPath = extractFilePath(existing.args);
    }

    acc.ttsrFired = acc.ttsr.checkDelta(fn.arguments, {
      source: "tool-args",
      ...(existing.extractedPath !== undefined
        ? { currentFile: existing.extractedPath }
        : {}),
    });
  }
}

/** Path keys arrive in the first bytes of the args JSON; past this, stop
 *  re-scanning (the write guard / run path re-parse the full args anyway). */
const MAX_PATH_SCAN_CHARS = 2048;

/** Extract file path from partial JSON args (e.g., "{"file":"src/app.ts",..."). */
function extractFilePath(args: string): string | undefined {
  const match = /"(?:file|path)"\s*:\s*"([^"]+)"/.exec(args);

  return match?.[1];
}

/** First of the candidates that is a string (vLLM uses `reasoning`; others `reasoning_content`). */
function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string") {
      return v;
    }
  }

  return undefined;
}
