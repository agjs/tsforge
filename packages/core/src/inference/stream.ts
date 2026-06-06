import type { IModelResponse, IToolCall } from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import { parseArgs, salvageToolCalls } from "./wire";

interface IStreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: unknown;
}

/** Streaming: parse SSE chunks, forward tokens to `onToken`, assemble the response. */
export async function streamResponse(
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
