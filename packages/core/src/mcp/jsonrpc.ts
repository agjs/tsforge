import { isRecord } from "../lib/guards";
import type { IJsonRpcResponse } from "./mcp.types";

/** Encode a JSON-RPC message as a single newline-terminated line.
 *  MCP's stdio transport frames each message as one line of UTF-8 JSON. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental decoder for newline-delimited JSON. Feed it raw stdout chunks
 * (which may split or join messages); it returns whichever complete JSON values
 * are now available and retains any partial trailing line. Malformed lines are
 * skipped rather than throwing, so one bad line can't wedge the stream.
 */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;

    const out: unknown[] = [];
    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();

      this.buffer = this.buffer.slice(newline + 1);

      if (line.length > 0) {
        const parsed = tryParse(line);

        if (parsed !== undefined) {
          out.push(parsed);
        }
      }

      newline = this.buffer.indexOf("\n");
    }

    return out;
  }
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Type guard for a JSON-RPC response carrying the given request id. */
export function isResponseFor(
  value: unknown,
  id: number
): value is IJsonRpcResponse {
  return isRecord(value) && value.jsonrpc === "2.0" && value.id === id;
}

/** Extract a human-readable error string from a JSON-RPC error member. */
export function errorText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const error = value.error;

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return null;
}
