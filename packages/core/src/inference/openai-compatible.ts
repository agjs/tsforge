import type {
  IChatMessage,
  ICompleteOptions,
  IModelResponse,
  IProvider,
  IToolCall,
} from "./types";
import type { IOpenAICompatibleConfig } from "./openai-compatible.types";
import { isArray, isRecord } from "../lib/guards";

/**
 * Talks to any OpenAI-compatible `/chat/completions` endpoint — which Ollama,
 * vLLM, and llama.cpp all expose for a local Qwen3.6. Supports streaming: pass
 * `onToken` to receive reasoning + content tokens as they arrive.
 */
export class OpenAICompatibleProvider implements IProvider {
  constructor(private readonly cfg: IOpenAICompatibleConfig) {}

  async complete(
    messages: IChatMessage[],
    opts: ICompleteOptions = {}
  ): Promise<IModelResponse> {
    const doFetch = this.cfg.fetch ?? fetch;
    const streaming = opts.onToken !== undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.cfg.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.cfg.apiKey}`;
    }

    const body = JSON.stringify({
      model: this.cfg.model,
      messages: messages.map(toWire),
      max_tokens: this.cfg.maxTokens ?? 8192,
      temperature: opts.temperature,
      ...(this.cfg.repetitionPenalty === undefined
        ? {}
        : { repetition_penalty: this.cfg.repetitionPenalty }),
      ...(opts.tools === undefined
        ? {}
        : { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" }),
      ...(opts.enableThinking === undefined
        ? {}
        : { chat_template_kwargs: { enable_thinking: opts.enableThinking } }),
      ...(opts.thinkingTokenBudget === undefined
        ? {}
        : { thinking_token_budget: opts.thinkingTokenBudget }),
      ...(streaming ? { stream: true } : {}),
    });

    // Retry transient CONNECTION blips (socket close / unable-to-connect) — the
    // connect happens before any stream starts, so retrying is safe for both
    // streaming and non-streaming. Essential for a long-running CLI; also stops
    // a network hiccup from wrecking an eval run.
    const res = await fetchWithRetry(
      doFetch,
      `${this.cfg.baseUrl}/chat/completions`,
      headers,
      body,
      this.cfg.timeoutMs ?? 600000
    );

    if (!res.ok) {
      throw new Error(`model request failed: ${res.status}`);
    }

    if (opts.onToken !== undefined) {
      return streamResponse(res, opts.onToken);
    }

    const data: unknown = await res.json();

    return parseResponse(data);
  }
}

// Transient CONNECTION failures (the box blipped / socket dropped) — retry these.
// Deliberately does NOT match timeouts: a request that ran past timeoutMs is a
// reasoning spiral, not a blip, and retrying would just waste another timeout.
const TRANSIENT_NETWORK =
  /unable to connect|socket connection|connection (was )?(closed|refused|reset)|econnrefused|econnreset/i;

function isTransientNetworkError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_NETWORK.test(err.message);
}

/**
 * Retry a request on transient connection failures only (HTTP errors surface via
 * `res.ok`, not a throw). Fresh AbortSignal per attempt; small linear backoff.
 * The connect completes before any stream begins, so this is safe for streaming.
 */
async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<Response> {
  const maxAttempts = 4;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err;

      if (!isTransientNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400 * attempt);
      });
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}

/** Map our message shape to the OpenAI wire shape (tool_calls / tool results). */
function toWire(m: IChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }

  if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }

  return { role: m.role, content: m.content };
}

/** Non-streaming: narrow the response shape with guards — no type assertions. */
function parseResponse(data: unknown): IModelResponse {
  const empty: IModelResponse = { content: "", toolCalls: [] };

  if (!isRecord(data)) {
    return empty;
  }

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
  const toolCalls = collectToolCalls(message.tool_calls);

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : salvageToolCalls(content),
  };
}

// Tool names the harness offers — the salvage parser only recognizes these, so
// it can't mistake arbitrary prose/JSX for a tool call.
const KNOWN_TOOLS = new Set([
  "read",
  "edit",
  "create",
  "run",
  "search",
  "symbol_search",
  "find_references",
  "type_at",
  "diagnostics",
  "rename_symbol",
  "organize_imports",
]);

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
  const calls: IToolCall[] = [];
  const blockRe =
    /<([a-z_]+)>\s*((?:<parameter=[^>]+>[\s\S]*?<\/parameter>\s*)+)/gi;

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

function collectToolCalls(rawCalls: unknown): IToolCall[] {
  const calls = isArray(rawCalls) ? rawCalls : [];
  const toolCalls: IToolCall[] = [];

  for (const tc of calls) {
    if (!isRecord(tc) || !isRecord(tc.function)) {
      continue;
    }

    const fn = tc.function;
    const id = typeof tc.id === "string" ? tc.id : undefined;
    const name = typeof fn.name === "string" ? fn.name : "";
    const args = typeof fn.arguments === "string" ? fn.arguments : undefined;

    toolCalls.push({ id, name, arguments: parseArgs(args) });
  }

  return toolCalls;
}

interface IStreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: unknown;
}

/** Streaming: parse SSE chunks, forward tokens to `onToken`, assemble the response. */
async function streamResponse(
  res: Response,
  onToken: (text: string) => void
): Promise<IModelResponse> {
  const body = res.body;

  if (body === null) {
    return { content: "", toolCalls: [] };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  let buffer = "";
  let content = "";
  let result = await reader.read();

  while (!result.done) {
    buffer += decoder.decode(result.value, { stream: true });

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const delta = parseSseLine(line);

      if (delta === null) {
        continue;
      }

      // Forward reasoning too — the log is the full record of what happened.
      // (The "too much output" problem is solved by making the model think
      // less, not by hiding it from the log.)
      if (delta.reasoning !== undefined && delta.reasoning.length > 0) {
        onToken(delta.reasoning);
      }

      if (delta.content !== undefined && delta.content.length > 0) {
        content += delta.content;
        onToken(delta.content);
      }

      accumulateToolCalls(delta.toolCalls, calls);
    }

    result = await reader.read();
  }

  const toolCalls: IToolCall[] = [...calls.values()].map((c) => ({
    id: c.id,
    name: c.name,
    arguments: parseArgs(c.args),
  }));

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : salvageToolCalls(content),
  };
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

  const choices = parsed.choices;
  const first = isArray(choices) ? choices[0] : undefined;

  if (!isRecord(first) || !isRecord(first.delta)) {
    return null;
  }

  const delta = first.delta;

  return {
    content: typeof delta.content === "string" ? delta.content : undefined,
    reasoning: firstString(delta.reasoning, delta.reasoning_content),
    toolCalls: delta.tool_calls,
  };
}

function accumulateToolCalls(
  raw: unknown,
  calls: Map<number, { name: string; args: string }>
): void {
  if (!isArray(raw)) {
    return;
  }

  for (const tc of raw) {
    if (!isRecord(tc) || !isRecord(tc.function)) {
      continue;
    }

    const index = typeof tc.index === "number" ? tc.index : 0;
    const fn = tc.function;
    const existing: { id?: string; name: string; args: string } = calls.get(
      index
    ) ?? { name: "", args: "" };

    if (typeof tc.id === "string" && tc.id.length > 0) {
      existing.id = tc.id;
    }

    if (typeof fn.name === "string" && fn.name.length > 0) {
      existing.name = fn.name;
    }

    if (typeof fn.arguments === "string") {
      existing.args += fn.arguments;
    }

    calls.set(index, existing);
  }
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

function parseArgs(raw?: string): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(raw);

    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
