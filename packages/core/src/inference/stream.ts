import type {
  IModelResponse,
  IToolCall,
  ITokenUsage,
  TokenChannel,
} from "./inference.types";
import { isArray, isRecord } from "../lib/guards";
import { parseArgs, parseUsage, salvageToolCalls } from "./wire";
import { StreamGuard } from "./stream-guard";

interface IStreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: unknown;
  usage?: ITokenUsage;
}

/** Streaming: parse SSE chunks, forward tokens to `onToken`, assemble the response. */
export async function streamResponse(
  res: Response,
  onToken: (text: string, channel: TokenChannel) => void
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

    if (degenerated) {
      // Stop the runaway generation instead of letting it spew to max_tokens.
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

interface IStreamAcc {
  calls: Map<number, { id?: string; name: string; args: string }>;
  guard: StreamGuard;
  content: string;
  usage?: ITokenUsage;
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

      if (acc.guard.observe(delta.reasoning, "reasoning")) {
        return true;
      }
    }

    if (delta.content !== undefined && delta.content.length > 0) {
      acc.content += delta.content;
      onToken(delta.content, "content");

      if (acc.guard.observe(delta.content, "content")) {
        return true;
      }
    }

    if (delta.usage !== undefined) {
      acc.usage = delta.usage;
    }

    accumulateToolCalls(delta.toolCalls, acc.calls, onToken);
  }

  return false;
}

function assemble(acc: IStreamAcc, degenerated: boolean): IModelResponse {
  const usage = acc.usage === undefined ? {} : { usage: acc.usage };
  const toolCalls: IToolCall[] = [...acc.calls.values()].map((c) => ({
    id: c.id,
    name: c.name,
    arguments: parseArgs(c.args),
  }));

  if (toolCalls.length > 0) {
    return degenerated
      ? { content: acc.content, toolCalls, degenerated, ...usage }
      : { content: acc.content, toolCalls, ...usage };
  }

  const salvaged = salvageToolCalls(acc.content);

  return {
    content: acc.content,
    toolCalls: salvaged,
    salvaged: salvaged.length,
    ...(degenerated ? { degenerated } : {}),
    ...usage,
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

function accumulateToolCalls(
  raw: unknown,
  calls: Map<number, { id?: string; name: string; args: string }>,
  onToken: (text: string, channel: TokenChannel) => void
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

    // Surface the tool name the moment it first appears — so a long tool-call
    // generation shows "it's writing X now" instead of a frozen cursor. The raw
    // argument JSON is NOT streamed (it's noisy); the file lands as a clean
    // create/edit event once the call runs.
    if (typeof fn.name === "string" && fn.name.length > 0) {
      if (existing.name.length === 0) {
        onToken(`\n  ✎ ${fn.name}…`, "tool");
      }

      existing.name = fn.name;
    }

    if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
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
