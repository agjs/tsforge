import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, mkdir } from "node:fs/promises";
import type { IChatMessage, IToolCall } from "./inference";
import { isRecord } from "./lib/guards";

/**
 * On-disk persistence for interactive CLI sessions, so `tsforge --continue` can
 * resume the most recent conversation for a working directory. One JSON file per
 * session under `~/.tsforge/sessions/`, rewritten after each turn. Deliberately
 * simple (flat files, no index) — a session is small and there are never many.
 */
export interface ISessionRecord {
  /** Stable id (also the filename stem). */
  id: string;
  /** The working directory this session ran against — `--continue` matches on it. */
  cwd: string;
  /** Gate command, if one was set. */
  accept: string;
  /** Editable scope globs. */
  files: string[];
  /** Last-write time (ms) — newest wins for `--continue`. */
  updatedAt: number;
  /** The full conversation, including the system message. */
  messages: IChatMessage[];
}

/** The sessions directory — under `$TSFORGE_HOME` if set (tests/sandboxing),
 *  else the user's home. Read at call time so it can be redirected per process. */
function storeDir(): string {
  return join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "sessions");
}

/** Persist (create or overwrite) a session record. */
export async function saveSession(record: ISessionRecord): Promise<void> {
  const dir = storeDir();

  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, `${record.id}.json`),
    JSON.stringify(record, null, 2)
  );
}

/** The most recently-updated session for `cwd`, or null if there is none. */
export async function latestSession(
  cwd: string
): Promise<ISessionRecord | null> {
  const dir = storeDir();
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return null; // no store yet
  }

  let best: ISessionRecord | null = null;

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const record = await readRecord(join(dir, name));

    if (record?.cwd !== cwd) {
      continue;
    }

    if (best === null || record.updatedAt > best.updatedAt) {
      best = record;
    }
  }

  return best;
}

async function readRecord(path: string): Promise<ISessionRecord | null> {
  try {
    const data: unknown = JSON.parse(await Bun.file(path).text());

    if (
      isRecord(data) &&
      typeof data.id === "string" &&
      typeof data.cwd === "string" &&
      typeof data.updatedAt === "number" &&
      Array.isArray(data.messages)
    ) {
      return {
        id: data.id,
        cwd: data.cwd,
        accept: typeof data.accept === "string" ? data.accept : "",
        files: Array.isArray(data.files)
          ? data.files.filter((f): f is string => typeof f === "string")
          : [],
        updatedAt: data.updatedAt,
        messages: toMessages(data.messages),
      };
    }
  } catch {
    // unreadable / malformed → skip it
  }

  return null;
}

/** Validate a persisted message array back into IChatMessage[] (no `as` casts). */
function toMessages(raw: readonly unknown[]): IChatMessage[] {
  const messages: IChatMessage[] = [];

  for (const item of raw) {
    const message = toMessage(item);

    if (message !== null) {
      messages.push(message);
    }
  }

  return messages;
}

function toMessage(raw: unknown): IChatMessage | null {
  if (!isRecord(raw)) {
    return null;
  }

  const role = toRole(raw.role);

  if (role === null) {
    return null;
  }

  const message: IChatMessage = {
    role,
    content: typeof raw.content === "string" ? raw.content : "",
  };

  if (typeof raw.toolCallId === "string") {
    message.toolCallId = raw.toolCallId;
  }

  const toolCalls = toToolCalls(raw.toolCalls);

  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }

  return message;
}

/** Narrow an unknown to the message role union via case-narrowing (no `as`). */
function toRole(value: unknown): IChatMessage["role"] | null {
  switch (value) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return value;
    default:
      return null;
  }
}

function toToolCalls(raw: unknown): IToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const calls: IToolCall[] = [];

  for (const call of raw) {
    if (
      isRecord(call) &&
      typeof call.name === "string" &&
      isRecord(call.arguments)
    ) {
      calls.push({
        id: typeof call.id === "string" ? call.id : undefined,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }

  return calls;
}
