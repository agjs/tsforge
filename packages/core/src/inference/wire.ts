import type {
  IChatMessage,
  IModelResponse,
  IToolCall,
  ITokenUsage,
} from "./inference.types";
import { ModelRequestError } from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import { TOOL_NAME } from "../agent";
import { projectWriteArgsForWire } from "../loop/context-hygiene";

/** Map our message shape to the OpenAI wire shape (tool_calls / tool results).
 *  `includeReasoning` re-attaches an assistant turn's `reasoning_content` —
 *  DeepSeek's thinking mode requires it replayed; other providers don't want it. */
export function toWire(
  m: IChatMessage,
  includeReasoning = false
): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }

  const reasoning =
    includeReasoning &&
    m.reasoningContent !== undefined &&
    m.reasoningContent.length > 0
      ? { reasoning_content: m.reasoningContent }
      : {};

  if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: m.role,
      content: m.content,
      ...reasoning,
      tool_calls: m.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(
            projectWriteArgsForWire(tc.name, tc.arguments)
          ),
        },
      })),
    };
  }

  return { role: m.role, content: m.content, ...reasoning };
}

/** Non-streaming: narrow the response shape with guards — no type assertions. */
/** Raise a body-borne error, keeping the server's own status when it gives one
 *  so a permanent rejection stays distinguishable from a blip. */
function throwIfErrorBody(data: Record<string, unknown>): void {
  const error = data.error;

  if (!isRecord(error)) {
    return;
  }

  const message =
    typeof error.message === "string" ? error.message : JSON.stringify(error);
  const status = typeof error.code === "number" ? error.code : 502;

  throw new ModelRequestError(status, message);
}

export function parseResponse(data: unknown): IModelResponse {
  const empty: IModelResponse = { content: "", toolCalls: [] };

  if (!isRecord(data)) {
    return empty;
  }

  // A 200 whose BODY is an error. The streaming path already refuses to read
  // this as silence; the non-streaming path is what the self-harness proposer,
  // the judge and the planner use, and there an empty completion is
  // indistinguishable from the model declining to answer. That is how a dead
  // endpoint produced months of "unparseable proposer response".
  throwIfErrorBody(data);

  const choices = data.choices;
  const first = isArray(choices) ? choices[0] : undefined;

  if (!isRecord(first)) {
    return empty;
  }

  const message = first.message;

  if (!isRecord(message)) {
    return empty;
  }

  const content = typeof message.content === "string" ? message.content : "";
  const finishReason =
    typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  const collected = collectToolCalls(
    message.tool_calls,
    finishReason === "length"
  );
  const usage = parseUsage(data.usage);
  const withUsage = usage === undefined ? {} : { usage };
  const withFinish = finishReason === undefined ? {} : { finishReason };
  const withTruncated = collected.truncated ? { truncated: true } : {};
  // Parity with the streaming path: vLLM spells it `reasoning`, others
  // `reasoning_content` — dropping the former lost the chain-of-thought on
  // every non-streaming call (judge/planner/proposer), and for a
  // replayReasoning profile the NEXT request then 400s for the missing replay.
  const reasoningText = firstString(
    message.reasoning,
    message.reasoning_content
  );
  const reasoning =
    reasoningText !== undefined && reasoningText.length > 0
      ? { reasoning: reasoningText }
      : {};

  if (collected.calls.length > 0 || collected.truncated) {
    return {
      content,
      toolCalls: collected.calls,
      ...reasoning,
      ...withUsage,
      ...withFinish,
      ...withTruncated,
    };
  }

  const salvaged = salvageToolCalls(content);

  return {
    content,
    toolCalls: salvaged,
    salvaged: salvaged.length,
    ...reasoning,
    ...withUsage,
    ...withFinish,
  };
}

/** Narrow a server `usage` block to ITokenUsage (no type assertions). */
export function parseUsage(raw: unknown): ITokenUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const promptTokens =
    typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completionTokens =
    typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  const totalTokens =
    typeof raw.total_tokens === "number"
      ? raw.total_tokens
      : promptTokens + completionTokens;
  const cachedPromptTokens = parseCachedPromptTokens(raw);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    // Spread, so an endpoint that reports nothing leaves the field ABSENT rather
    // than present-and-undefined — see ITokenUsage on why 0 and "unsaid" differ.
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
  };
}

/** Prefix-cache hits, under either spelling the endpoints we target use: OpenAI
 *  and vLLM nest it as `prompt_tokens_details.cached_tokens`, while DeepSeek's
 *  cloud API reports a top-level `prompt_cache_hit_tokens`. Checked in that
 *  order because a gateway fronting DeepSeek may emit both, and the nested form
 *  is the standard one. */
function parseCachedPromptTokens(
  raw: Record<string, unknown>
): number | undefined {
  const details = raw.prompt_tokens_details;

  if (isRecord(details) && typeof details.cached_tokens === "number") {
    return details.cached_tokens;
  }

  return typeof raw.prompt_cache_hit_tokens === "number"
    ? raw.prompt_cache_hit_tokens
    : undefined;
}

// Tool names the harness offers — the salvage parser only recognizes these, so
// it can't mistake arbitrary prose/JSX for a tool call. Derived from the single
// TOOL_NAME registry (no second hardcoded list to drift).
const KNOWN_TOOLS = new Set<string>(Object.values(TOOL_NAME));

/**
 * Salvage tool calls the model emitted as MALFORMED text instead of structured
 * `tool_calls`. The local model intermittently (prompt-dependent, temp-0
 * boundary) emits a non-standard XML form that vLLM's parser leaves in content,
 * e.g.:
 *   <read>
 *   <parameter=file>
 *   src/App.tsx
 *   </parameter>
 *   </function>
 *   </tool_call>
 * which would otherwise strand the loop (0 tool calls → stall). We extract
 * `<toolname> … <parameter=key>value</parameter> …` blocks for KNOWN tools only.
 * Used ONLY when the structured `tool_calls` came back empty, so it can never
 * override a properly-parsed call. See memory: malformed-toolcall-format.
 */
export function salvageToolCalls(content: string): IToolCall[] {
  return dedupeCalls([
    ...salvageXmlCalls(content),
    ...salvageParamsBlockCalls(content),
    ...salvagePipeCalls(content),
  ]);
}

/**
 * Collapse identical repeated calls. A model whose tool format the server can't
 * parse (e.g. atlas-spark NVFP4) leaks calls into content AND tends to emit the
 * SAME call several times in one response. Salvaging all of them would run the
 * action N times (or, for `read`/`run`, churn) and feed the loop; deduping to
 * the first of each distinct (name, args) keeps exactly the intended work.
 */
function dedupeCalls(calls: IToolCall[]): IToolCall[] {
  const seen = new Set<string>();
  const out: IToolCall[] = [];

  for (const call of calls) {
    const key = `${call.name}\u0000${JSON.stringify(call.arguments)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(call);
  }

  return out;
}

/**
 * The `<toolname> … <parameter=key>value</parameter> …` XML form — including the
 * `<function=toolname>` wrapper variant (Qwen3.5-native XML, which Atlas's
 * `qwen3_coder`/`hermes` parsers don't match, so it leaks into content). The
 * `function=` prefix is optional so BOTH `<create>…` and `<function=create>…`
 * are salvaged.
 */
function salvageXmlCalls(content: string): IToolCall[] {
  const calls: IToolCall[] = [];
  const blockRe =
    /<(?:function=)?([a-z_]+)>\s*((?:<parameter=[^>]+>[\s\S]*?<\/parameter>\s*)+)/gi;

  for (const block of content.matchAll(blockRe)) {
    const name = block[1];
    const params = block[2];

    if (name === undefined || params === undefined || !KNOWN_TOOLS.has(name)) {
      continue;
    }

    const args: Record<string, unknown> = {};

    for (const p of params.matchAll(
      /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
    )) {
      const key = p[1]?.trim();
      const value = p[2];

      if (key !== undefined && key.length > 0 && value !== undefined) {
        args[key] = value.trim();
      }
    }

    if (Object.keys(args).length > 0) {
      calls.push({ id: undefined, name, arguments: args });
    }
  }

  return calls;
}

/**
 * Recover a STRUCTURED tool call whose `name` absorbed the whole XML body — the
 * server's tool parser mis-split a bare `edit\n<parameter=file>…</parameter>…`
 * emission (qwen3.6-27b: the tool name NOT wrapped in `<function=…>`, so the
 * parser couldn't find the boundary and put everything in `function.name` with
 * empty/garbage args). Observed live: name = `edit<parameter=file…`, denied by the
 * policy as an "unknown tool" and looped to the stall cap. Unlike `salvageXmlCalls`
 * (which works on leaked CONTENT text and needs a `<name>`/`<function=name>`
 * wrapper), this rescues the STRUCTURED path: leading identifier → name, the
 * `<parameter=key>value</parameter>` blocks (closing tags optional) → arguments.
 * Returns null when `name` isn't this fused form or the tool is unknown.
 */
export function salvageFusedToolName(
  rawName: string,
  rawArgs: unknown
): { name: string; arguments: Record<string, unknown> } | null {
  if (typeof rawName !== "string" || !rawName.includes("<parameter=")) {
    return null;
  }

  const name = /^[\s<]*(?:function=)?([a-z_]+)/iu.exec(rawName)?.[1];

  if (name === undefined || !KNOWN_TOOLS.has(name)) {
    return null;
  }

  const blob = rawName + (typeof rawArgs === "string" ? rawArgs : "");
  const markers = [...blob.matchAll(/<parameter=([^>]+)>/gu)];
  const args: Record<string, unknown> = {};

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    const key = marker?.[1]?.trim();

    if (marker === undefined || key === undefined || key.length === 0) {
      continue;
    }

    const start = marker.index + marker[0].length;
    const end = markers[i + 1]?.index ?? blob.length;
    // The slice is `value</parameter>` (or `value</parameter></function>` for the
    // last one, or bare `value` if the model omitted the close) — strip trailing
    // close tags, function first so a `</parameter></function>` tail fully clears.
    const value = blob
      .slice(start, end)
      .replace(/<\/function>\s*$/u, "")
      .replace(/<\/parameter>\s*$/u, "")
      .trim();

    args[key] = value;
  }

  return Object.keys(args).length > 0 ? { name, arguments: args } : null;
}

/**
 * The `<toolname>\n<parameters>\n<key>\nvalue\n</parameters>` form — captured
 * live from qwen3.6-27b in the interactive CLI (a scaffold_web call): a
 * `<parameters>` (PLURAL, no `=`) wrapper whose keys are bare `<key>` tags with
 * the value on the following line(s), the key's closing tag usually missing.
 * Values are read up to the next `<` — fine for the short args this variant has
 * been seen with (paths, framework names); a `create` whose content embeds tags
 * would truncate, but an un-stranded loop beats a stalled one.
 */
function salvageParamsBlockCalls(content: string): IToolCall[] {
  const calls: IToolCall[] = [];
  const blockRe = /<([a-z_]+)>\s*<parameters>\s*([\s\S]*?)\s*<\/parameters>/gi;

  for (const block of content.matchAll(blockRe)) {
    const name = block[1];
    const body = block[2];

    if (name === undefined || body === undefined || !KNOWN_TOOLS.has(name)) {
      continue;
    }

    const args: Record<string, unknown> = {};

    for (const p of body.matchAll(/<([a-z_]+)>\s*([^<]*)/g)) {
      const key = p[1]?.trim();
      const value = p[2]?.trim();

      if (
        key !== undefined &&
        key.length > 0 &&
        value !== undefined &&
        value.length > 0
      ) {
        args[key] = value;
      }
    }

    if (Object.keys(args).length > 0) {
      calls.push({ id: undefined, name, arguments: args });
    }
  }

  return calls;
}

/**
 * The Qwen-channel pipe form: `<|read|>{"file": "a.ts"}` — a `<|toolname|>`
 * marker followed by a JSON arguments object. Seen live from qwen3.6-35b-a3b in
 * the interactive CLI when the server's tool-call parser leaves it in content.
 * The object is extracted with a string-aware brace scan so code containing
 * braces (in `edit`/`create` args) doesn't truncate it.
 */
function salvagePipeCalls(content: string): IToolCall[] {
  const calls: IToolCall[] = [];

  for (const m of content.matchAll(/<\|([a-z_]+)\|>[ \t]*/gi)) {
    const name = m[1];
    const open = m.index + m[0].length;

    if (name === undefined || !KNOWN_TOOLS.has(name) || content[open] !== "{") {
      continue;
    }

    const obj = jsonObjectAt(content, open);

    if (obj === null) {
      continue;
    }

    const args = parseArgs(obj);

    if (Object.keys(args).length > 0) {
      calls.push({ id: undefined, name, arguments: args });
    }
  }

  return calls;
}

/** Extract the balanced `{…}` starting at `open`, respecting string literals. */
function jsonObjectAt(s: string, open: number): string | null {
  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = open; i < s.length; i += 1) {
    const c = s[i];

    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inStr = false;
      }

      continue;
    }

    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;

      if (depth === 0) {
        return s.slice(open, i + 1);
      }
    }
  }

  return null;
}

function collectToolCalls(
  rawCalls: unknown,
  dropUnparseable = false
): { calls: IToolCall[]; truncated: boolean } {
  const calls = isArray(rawCalls) ? rawCalls : [];
  const toolCalls: IToolCall[] = [];
  let truncated = false;

  for (const tc of calls) {
    if (!isRecord(tc) || !isRecord(tc.function)) {
      continue;
    }

    const fn = tc.function;
    const id = typeof tc.id === "string" ? tc.id : undefined;
    const name = typeof fn.name === "string" ? fn.name : "";
    const args = fn.arguments;

    // Same rescue as the streaming path: a `name` that swallowed the XML body
    // (`edit<parameter=file>…`) is recovered to its real name + parsed parameters.
    const fused = salvageFusedToolName(name, args);

    if (fused !== null) {
      toolCalls.push({ id, name: fused.name, arguments: fused.arguments });
      continue;
    }

    const parsed = parseArgsOrNull(args);

    // finish_reason:"length" + args cut mid-JSON: drop the call and flag
    // `truncated` instead of executing it with silently-empty {} args.
    if (parsed === null && dropUnparseable) {
      truncated = true;
      continue;
    }

    toolCalls.push({ id, name, arguments: parsed ?? {} });
  }

  return { calls: toolCalls, truncated };
}

export function parseArgs(raw?: unknown): Record<string, unknown> {
  return parseArgsOrNull(raw) ?? {};
}

/** Like parseArgs, but reports FAILURE as null instead of silently degrading a
 *  non-empty-but-unparseable args string to {} — callers use this to tell
 *  "the model sent no args" from "the args were cut off mid-JSON" (the
 *  finish_reason:"length" truncation case). */
export function parseArgsOrNull(raw?: unknown): Record<string, unknown> | null {
  if (raw === undefined) {
    return {};
  }

  if (isRecord(raw)) {
    return raw;
  }

  if (typeof raw !== "string") {
    return null;
  }

  if (raw.trim().length === 0) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(raw);

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** First of the candidates that is a string (vLLM uses `reasoning`; others
 *  `reasoning_content`) — shared by the streaming and non-streaming parsers so
 *  the two paths can't drift on which spelling they accept. */
export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string") {
      return v;
    }
  }

  return undefined;
}
