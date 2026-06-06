import type { IChatMessage, IModelResponse, IToolCall } from "./types";
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

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : salvageToolCalls(content),
  };
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

export function parseArgs(raw?: string): Record<string, unknown> {
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
