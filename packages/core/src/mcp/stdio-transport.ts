import { isRecord } from "../lib/guards";
import { LineDecoder, encodeMessage, errorText } from "./jsonrpc";
import type {
  IMcpServerConfig,
  IMcpToolInfo,
  IMcpTransport,
} from "./mcp.types";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30000;

interface IPending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Render an MCP `tools/list` result into typed tool info, dropping bad entries. */
function extractTools(result: unknown): IMcpToolInfo[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    return [];
  }

  const tools: IMcpToolInfo[] = [];

  for (const entry of result.tools) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }

    tools.push({
      name: entry.name,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : {},
    });
  }

  return tools;
}

/** Render an MCP `tools/call` result's content array into plain text. */
function extractText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }

  const parts: string[] = [];

  for (const item of result.content) {
    if (isRecord(item) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.length > 0 ? parts.join("\n") : JSON.stringify(result);
}

/**
 * MCP transport over a child process's stdio, framed as newline-delimited
 * JSON-RPC. Performs the `initialize` handshake on connect, multiplexes requests
 * by id, and enforces a per-call timeout so a hung server cannot stall the loop.
 */
export class StdioMcpTransport implements IMcpTransport {
  private proc: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, IPending>();
  private readonly timeoutMs: number;
  private nextId = 0;

  constructor(
    private readonly name: string,
    private readonly config: IMcpServerConfig
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.config.command === undefined) {
      throw new Error(`MCP server '${this.name}' has no command`);
    }

    const proc = Bun.spawn({
      cmd: [this.config.command, ...(this.config.args ?? [])],
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    this.proc = proc;
    void this.readLoop(proc.stdout);

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tsforge", version: "0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<IMcpToolInfo[]> {
    return extractTools(await this.request("tools/list", {}));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    return extractText(
      await this.request("tools/call", { name, arguments: args })
    );
  }

  close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("transport closed"));
    }

    this.pending.clear();
    this.proc?.kill();
    this.proc = null;

    return Promise.resolve();
  }

  private async readLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const textDecoder = new TextDecoder();
    let done = false;

    while (!done) {
      const result = await reader.read();

      done = result.done;

      if (result.value !== undefined) {
        const text = textDecoder.decode(result.value, { stream: true });

        for (const message of this.decoder.push(text)) {
          this.handleMessage(message);
        }
      }
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    const err = errorText(message);

    if (err !== null) {
      pending.reject(new Error(err));

      return;
    }

    pending.resolve(message.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;

    if (proc === null) {
      return Promise.reject(new Error("transport not connected"));
    }

    const id = this.nextId;

    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request '${method}' timed out after ${this.timeoutMs}ms`
          )
        );
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      void proc.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id, method, params })
      );
      void proc.stdin.flush();
    });
  }

  private notify(method: string, params: unknown): void {
    const proc = this.proc;

    if (proc === null) {
      return;
    }

    void proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
    void proc.stdin.flush();
  }
}
