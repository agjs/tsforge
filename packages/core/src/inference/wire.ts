import type {
  IChatMessage,
  IModelResponse,
  IToolCall,
  ITokenUsage,
} from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import { TOOL_NAME } from "../agent";

/** Map our message shape to the OpenAI wire shape (tool_calls / tool results). */
export function toWire(m: IChatMessage): Record<string, unknown> {
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
export function parseResponse(data: unknown): IModelResponse {
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
  const usage = parseUsage(data.usage);
  const withUsage = usage === undefined ? {} : { usage };

  if (toolCalls.length > 0) {
    return { content, toolCalls, ...withUsage };
  }

  const salvaged = salvageToolCalls(content);

  return {
    content,
    toolCalls: salvaged,
    salvaged: salvaged.length,
    ...withUsage,
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

  return { promptTokens, completionTokens, totalTokens };
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
  return [...salvageXmlCalls(content), ...salvagePipeCalls(content)];
}

/** The `<toolname> … <parameter=key>value</parameter> …` XML form. */
function salvageXmlCalls(content: string): IToolCall[] {
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
    const args = fn.arguments;

    toolCalls.push({ id, name, arguments: parseArgs(args) });
  }

  return toolCalls;
}

export function parseArgs(raw?: unknown): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }

  if (isRecord(raw)) {
    return raw;
  }

  if (typeof raw !== "string") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(raw);

    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
