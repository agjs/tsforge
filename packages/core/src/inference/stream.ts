import type {
  IModelResponse,
  IToolCall,
  ITokenUsage,
  ITtsrWatcher,
  TokenChannel,
} from "./inference.types";
import { ModelRequestError, StreamInterruptedError } from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import {
  parseArgsOrNull,
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
  finishReason?: string;
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
    // Silently returning an empty completion here reads as "the model chose to
    // say nothing" — the same worst-outcome shape throwIfStreamError exists for.
    throw new ModelRequestError(
      502,
      "response had no body — expected an SSE stream"
    );
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

  try {
    let result = await readOrInterrupt(reader, acc);

    while (!result.done) {
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split("\n");

      buffer = lines.pop() ?? "";

      degenerated = consumeLines(lines, acc, onToken);

      if (degenerated || acc.ttsrFired !== null) {
        // Stop the runaway generation instead of letting it spew to max_tokens,
        // or abort when TTSR fires to inject corrective guidance.
        break;
      }

      result = await readOrInterrupt(reader, acc);
    }
  } finally {
    // ALWAYS release the connection — an SSE error event thrown out of
    // consumeLines used to leave the reader (and socket) dangling for GC.
    // Cancelling an already-closed reader is a no-op.
    await reader.cancel().catch(() => undefined);
  }

  buffer += decoder.decode();

  // Do not consume the trailing buffer after a degeneration OR a TTSR abort —
  // the abort decision was made; more tokens appended after it would land in
  // content the caller records.
  if (!degenerated && acc.ttsrFired === null && buffer.trim().length > 0) {
    degenerated = consumeLines([buffer], acc, onToken);
  }

  return assemble(acc, degenerated);
}

/** One reader.read() that converts a MID-STREAM failure (timeout firing at
 *  token 15k of 16k, a socket reset) into StreamInterruptedError carrying the
 *  partial response — instead of discarding everything already generated.
 *  A ModelRequestError (server-sent error event) passes through untouched
 *  elsewhere; only transport-level read failures are wrapped here. */
async function readOrInterrupt(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: IStreamAcc
): Promise<
  Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>
> {
  try {
    return await reader.read();
  } catch (err) {
    throw new StreamInterruptedError(assemble(acc, false), err);
  }
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
  /** True once the bounded path-scan window is exhausted (found, or the full
   *  prefix arrived pathless) — stop rescanning. */
  pathScanDone?: boolean;
}

interface IStreamAcc {
  calls: Map<number, IStreamingCall>;
  guard: StreamGuard;
  content: string;
  reasoning: string;
  usage?: ITokenUsage;
  ttsr?: ITtsrWatcher;
  ttsrFired: { readonly name: string; readonly guidance: string } | null;
  /** Last non-empty finish_reason seen ("stop" | "length" | "tool_calls" | …). */
  finishReason?: string;
  /** The slot the last tool-call delta landed in — the anchor for inferring
   *  call boundaries when a backend omits `index` (see resolveCallIndex). */
  lastCallIndex?: number;
  /** One-time ⚠ so a missing-index stream is visible in the log exactly once. */
  noIndexWarned?: boolean;
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

    if (delta.finishReason !== undefined) {
      acc.finishReason = delta.finishReason;
    }

    accumulateToolCalls(delta.toolCalls, acc.calls, onToken, acc);
  }

  return false;
}

function assemble(acc: IStreamAcc, degenerated: boolean): IModelResponse {
  const usage = acc.usage === undefined ? {} : { usage: acc.usage };
  const reasoning =
    acc.reasoning.length > 0 ? { reasoning: acc.reasoning } : {};
  // Emit in INDEX order, not Map-insertion order — a backend may interleave
  // index 1 before index 0, and two edits to the same file must not execute
  // in reverse.
  const toolCalls: IToolCall[] = [];
  let truncated = false;

  for (const [, c] of [...acc.calls.entries()].sort(([a], [b]) => a - b)) {
    // Rescue a structured call whose `name` absorbed the XML body (qwen emitted a
    // bare `edit<parameter=file>…` the server couldn't split) — otherwise the
    // garbage name hits the policy as an "unknown tool" and the model loops on it.
    const fused = salvageFusedToolName(c.name, c.args);

    if (fused !== null) {
      toolCalls.push({
        id: c.id,
        name: fused.name,
        arguments: fused.arguments,
      });
      continue;
    }

    const parsedArgs = parseArgsOrNull(c.args);

    // finish_reason:"length" + args cut mid-JSON: DROP the call and flag
    // truncation — executing it with silently-empty {} args was the old
    // behavior (the create-with-no-content loop). The loop steers on
    // `truncated` with an explicit smaller-call resteer instead.
    if (parsedArgs === null && acc.finishReason === "length") {
      truncated = true;
      continue;
    }

    toolCalls.push({ id: c.id, name: c.name, arguments: parsedArgs ?? {} });
  }

  const ttsrFired =
    acc.ttsrFired !== null
      ? {
          ttsrFired: {
            ruleName: acc.ttsrFired.name,
            guidance: acc.ttsrFired.guidance,
          },
        }
      : {};
  const finish =
    acc.finishReason === undefined ? {} : { finishReason: acc.finishReason };
  const wasTruncated = truncated ? { truncated: true } : {};

  if (toolCalls.length > 0 || truncated) {
    return degenerated
      ? {
          content: acc.content,
          toolCalls,
          degenerated,
          ...reasoning,
          ...ttsrFired,
          ...usage,
          ...finish,
          ...wasTruncated,
        }
      : {
          content: acc.content,
          toolCalls,
          ...reasoning,
          ...ttsrFired,
          ...usage,
          ...finish,
          ...wasTruncated,
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
    ...finish,
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
    const fin =
      isRecord(first) && typeof first.finish_reason === "string"
        ? { finishReason: first.finish_reason }
        : {};

    return usage === undefined && Object.keys(fin).length === 0
      ? null
      : { ...(usage === undefined ? {} : { usage }), ...fin };
  }

  const delta = first.delta;
  const finishReason =
    typeof first.finish_reason === "string" && first.finish_reason.length > 0
      ? { finishReason: first.finish_reason }
      : {};

  return {
    content: typeof delta.content === "string" ? delta.content : undefined,
    reasoning: firstString(delta.reasoning, delta.reasoning_content),
    toolCalls: delta.tool_calls,
    ...(usage === undefined ? {} : { usage }),
    ...finishReason,
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

  // Same bound as the TTSR latch: scan only the bounded PREFIX — the old
  // `args.length <= cap` SKIP meant a single large first delta (a whole file
  // body in one SSE frame) never surfaced its path at all. Give up for good
  // once the prefix is complete and pathless.
  if (call.pathShown !== true) {
    const path = /"(?:file|filename|path)"\s*:\s*"([^"]+)"/.exec(
      call.args.slice(0, MAX_PATH_SCAN_CHARS)
    )?.[1];

    if (path !== undefined) {
      call.pathShown = true;
      onToken(`\n  ${streamToolGlyph(call.name)} → ${path}`, "tool");
    } else if (call.args.length >= MAX_PATH_SCAN_CHARS) {
      // The whole window is here and holds no path — stop rescanning.
      call.pathShown = true;
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

/**
 * The slot a tool-call delta belongs to. With an `index` field this is trivial.
 * WITHOUT one (Mistral-compat, some llama.cpp builds, gateways that re-emit
 * calls), everything used to collapse into slot 0: N parallel calls fused into
 * one, their argument strings concatenated into `{"a":1}{"b":2}` — which
 * parseArgs degrades to `{}` — so the loop executed ONE call with the wrong
 * name and EMPTY args, silently. Heuristics for the index-less shape:
 * a NEW id, or a name arriving after the current call's args already started,
 * begins a new call; otherwise the delta continues the current one.
 */
function resolveCallIndex(
  tc: Record<string, unknown>,
  fn: Record<string, unknown>,
  calls: Map<number, IStreamingCall>,
  acc: IStreamAcc | undefined,
  onToken: (text: string, channel: TokenChannel) => void
): number {
  if (typeof tc.index === "number") {
    if (acc !== undefined) {
      acc.lastCallIndex = tc.index;
    }

    return tc.index;
  }

  if (acc !== undefined && acc.noIndexWarned !== true) {
    acc.noIndexWarned = true;
    onToken(
      "\n  ⚠ tool_call delta missing index — inferring call boundaries",
      "tool"
    );
  }

  const last = acc?.lastCallIndex ?? 0;

  if (calls.size === 0) {
    if (acc !== undefined) {
      acc.lastCallIndex = 0;
    }

    return 0;
  }

  const current = calls.get(last);
  const newId =
    typeof tc.id === "string" && tc.id.length > 0 && tc.id !== current?.id;
  const nameAfterArgs =
    typeof fn.name === "string" &&
    fn.name.length > 0 &&
    (current?.args.length ?? 0) > 0;
  const index = newId || nameAfterArgs ? last + 1 : last;

  if (acc !== undefined) {
    acc.lastCallIndex = index;
  }

  return index;
}

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

    const index = resolveCallIndex(tc, tc.function, calls, acc, onToken);
    const existing: IStreamingCall = calls.get(index) ?? { name: "", args: "" };
    const hasId = typeof tc.id === "string" && tc.id.length > 0;

    if (hasId) {
      existing.id = typeof tc.id === "string" ? tc.id : existing.id;
    }

    processToolCallDelta(tc.function, existing, hasId, onToken, acc);
    calls.set(index, existing);
  }
}

function processToolCallDelta(
  fn: Record<string, unknown>,
  existing: IStreamingCall,
  hasId: boolean,
  onToken: (text: string, channel: TokenChannel) => void,
  acc?: IStreamAcc
): void {
  // Surface the tool name the moment it first appears — so a long tool-call
  // generation shows "it's writing X now" instead of a frozen cursor. As the
  // (often large) file body then streams, emitToolProgress adds the path + a
  // throttled size heartbeat; the file lands as a clean create/edit event on run.
  //
  // Name semantics: OpenAI/vLLM/DeepSeek send the full name once, with the id,
  // on a call's first delta — that hits the first branch. An id-less name
  // fragment while args are still empty is a CONTINUATION (some backends split
  // the name across deltas: "cre" + "ate"); it appends, so the old overwrite
  // no longer turns `create` into `ate` → an unknown-tool denial loop. A name
  // arriving WITH an id (a re-declaration of the slot) replaces. Identical
  // re-sends are a no-op either way. (Cosmetic: the glyph line printed on the
  // first fragment can show a partial name.)
  if (typeof fn.name === "string" && fn.name.length > 0) {
    if (existing.name.length === 0) {
      onToken(`\n  ${streamToolGlyph(fn.name)} ${fn.name}…`, "tool");
      existing.name = fn.name;
    } else if (hasId || existing.args.length > 0) {
      existing.name = fn.name;
    } else if (fn.name !== existing.name) {
      existing.name += fn.name;
    }
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
    // Latch the path once (mirrors pathShown): scan the bounded PREFIX. The
    // old `args.length <= cap` guard SKIPPED the scan entirely when a backend
    // delivered the whole args in one large delta — so extractedPath was never
    // set and every file-scoped TTSR rule silently never fired.
    if (
      existing.extractedPath === undefined &&
      existing.pathScanDone !== true
    ) {
      existing.extractedPath = extractFilePath(
        existing.args.slice(0, MAX_PATH_SCAN_CHARS)
      );

      if (
        existing.extractedPath !== undefined ||
        existing.args.length >= MAX_PATH_SCAN_CHARS
      ) {
        existing.pathScanDone = true;
      }
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
