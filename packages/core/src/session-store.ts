import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, mkdir, chmod, stat, unlink } from "node:fs/promises";
import type { IChatMessage, IToolCall } from "./inference";
import { isRecord } from "./lib/guards";

/** Days to keep a session before `pruneSessions` deletes it (env-overridable). */
const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** Persistence is off when TSFORGE_NO_PERSIST is set — sessions stay in memory only. */
export function persistenceEnabled(): boolean {
  return (process.env.TSFORGE_NO_PERSIST ?? "") === "";
}

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

/**
 * Persist (create or overwrite) a session record — unless persistence is off.
 * Secrets in message text are redacted FIRST (so they never hit disk), the dir
 * is created 0700 and the file written 0600 (owner-only). We deliberately do NOT
 * encrypt: a key stored beside the data only deters backup/sync exfil, not local
 * compromise — data minimization (redaction) + perms is the higher-value floor.
 */
export async function saveSession(record: ISessionRecord): Promise<void> {
  if (!persistenceEnabled()) {
    return;
  }

  const dir = storeDir();
  const path = join(dir, `${record.id}.json`);
  const safe: ISessionRecord = {
    ...record,
    messages: redactMessages(record.messages),
  };

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(safe, null, 2));
  await chmod(path, 0o600);
}

/** Delete sessions older than `ttlDays` (by file mtime). Best-effort; never throws. */
export async function pruneSessions(ttlDays?: number): Promise<void> {
  const envTtl = Number(process.env.TSFORGE_SESSION_TTL_DAYS);
  const ttl = ttlDays ?? (Number.isFinite(envTtl) ? envTtl : DEFAULT_TTL_DAYS);
  const dir = storeDir();
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const cutoff = Date.now() - ttl * MS_PER_DAY;

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const path = join(dir, name);

    try {
      const info = await stat(path);

      if (info.mtimeMs < cutoff) {
        await unlink(path);
      }
    } catch {
      // racing deletion / unreadable — skip
    }
  }
}

/** All saved sessions for `cwd`, newest first. */
export async function listSessions(cwd: string): Promise<ISessionRecord[]> {
  const dir = storeDir();
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return []; // no store yet
  }

  const records: ISessionRecord[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const record = await readRecord(join(dir, name));

    if (record !== null && record.cwd === cwd) {
      records.push(record);
    }
  }

  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recently-updated session for `cwd`, or null if there is none. */
export async function latestSession(
  cwd: string
): Promise<ISessionRecord | null> {
  return (await listSessions(cwd))[0] ?? null;
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

const REDACTED = "[redacted]";

// A PEM private-key block — redact the whole thing.
const PRIVATE_KEY_BLOCK =
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g;

// A password embedded in a connection-string's userinfo (`scheme://user:PASS@host`).
const CONNECTION_PASSWORD = /(:\/\/[^\s:/@]*:)[^\s:/@]+(@)/g;

// `<key>: <value>` / `<key> = <value>` where the key NAME contains a secret word.
// The value is only redacted when it actually looks like a secret (see
// valueLooksSecret) — so `password: string` (a type annotation) survives.
const SECRET_KEYWORD =
  /\b([\w.]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credentials?|auth[_-]?token|private[_-]?key)[\w.]*)(\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;{}()]+)/gi;

// Standalone secret SHAPES — the whole match is the secret, replaced wholesale.
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys (incl. sk-proj-)
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, // Stripe sk_live_/pk_test_/rk_…
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_, gho_, …)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm token
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, // Authorization: Bearer …
];

/** Does a `key=` value look like a real secret (vs a type/identifier)? */
function valueLooksSecret(value: string): boolean {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));

  if (quoted) {
    return value.length - 2 >= 3; // a non-trivial quoted literal
  }

  // A bare token: secret-looking if it has non-letters (digits/symbols) or is
  // long. A short pure-letter word (`string`, `number`, `getInput`) is kept.
  return /[^A-Za-z]/.test(value) || value.length >= 16;
}

/**
 * Scrub secrets from text before it is persisted (data minimization). Covers
 * private-key blocks, connection-string passwords, `<secret-key>: <value>`
 * assignments (only when the value looks like a real secret), and a battery of
 * known token shapes (OpenAI/Stripe/GitHub/AWS/Google/Slack/npm/JWT/Bearer).
 */
export function redactText(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);

  out = out.replace(CONNECTION_PASSWORD, `$1${REDACTED}$2`);

  out = out.replace(
    SECRET_KEYWORD,
    (match: string, key: string, sep: string, value: string) =>
      valueLooksSecret(value) ? `${key}${sep}${REDACTED}` : match
  );

  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, REDACTED);
  }

  return out;
}

/**
 * Redact every message before persisting: its text (user prompts, assistant
 * answers, AND tool output — a `cat .env` dump is a real leak vector) AND the
 * string values inside tool-call arguments (a token pasted into a `run` command
 * or `create` content). Structure is preserved; only string values are scrubbed.
 */
function redactMessages(messages: readonly IChatMessage[]): IChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: redactText(message.content),
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: redactToolCalls(message.toolCalls) }),
  }));
}

function redactToolCalls(calls: readonly IToolCall[]): IToolCall[] {
  return calls.map((call) => ({
    ...call,
    arguments: redactArgs(call.arguments),
  }));
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "string" ? redactText(value) : value;
  }

  return out;
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
