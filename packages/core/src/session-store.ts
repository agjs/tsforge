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
  /** The gate was tsforge's AUTO gate (not an explicit `--accept`/manual `/gate`) when
   *  last saved. On `--continue` an auto session re-attaches the stack re-detection
   *  resolver instead of freezing on the stored command; a manual/off session keeps
   *  its stored `accept` verbatim. Absent on pre-existing records → treated as manual. */
  auto?: boolean;
  /** The `--profile` (strictness level) the session was started with, if any. Re-applied
   *  on `--continue` so a resumed build keeps its strictness without the user re-passing
   *  the flag — a project resumed months later stays at the level it was built at. Absent
   *  ⇒ no CLI profile (the project's tsforge.config.json / default drives it, as always). */
  profile?: string;
  /** `--strict-floor-only` was set when the session started. Re-applied on
   *  `--continue` so resume keeps omitting project tests from the auto gate. */
  strictFloorOnly?: boolean;
  /** Editable scope globs. */
  files: string[];
  /** Last-write time (ms) — newest wins for `--continue`. */
  updatedAt: number;
  /** Plan mode was on when last saved — restored on `--continue` so a resumed
   *  session doesn't silently drop its read-only guarantee. */
  planMode?: boolean;
  /** A still-unvalidated edit was pending behind an ask_user pause when last saved —
   *  restored on `--continue`/`--resume` so a resumed session re-gates that edit on its
   *  first send instead of silently dropping the deferred gate (WS-C, same as /clear). */
  pausedWithEdit?: boolean;
  /** Files the model wrote this session (relative paths). Restored on `--continue`
   *  so a workspace-container gate still fans out to the right packages after a
   *  pause — without this, resume sees an empty touched set and false-greens. */
  touched?: string[];
  /** Session-bound checklist plan id (`plans/<id>.json`). Restored on `--continue`
   *  so task_* tools, turn inject, and the Tasks rail stay scoped to this session's
   *  plan (concurrent sessions in one project each bind their own id). */
  activePlanId?: string | null;
  /** Last server-reported prompt size (tokens). Seeds the resumed session's
   *  auto-compaction gauge so the FIRST send after --continue can compact a
   *  near-full transcript instead of firing blind at full size. */
  lastPromptTokens?: number;
  /** The full conversation, including the system message. */
  messages: IChatMessage[];
}

/** The sessions directory — under `$TSFORGE_HOME` if set (tests/sandboxing),
 *  else the user's home. Read at call time so it can be redirected per process. */
function storeDir(): string {
  return join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "sessions");
}

/** The run-logs directory (`--log`): `$TSFORGE_HOME`/.tsforge/logs, else under the
 *  user's home. A fixed, predictable location so logs are always findable. */
export function logsDir(): string {
  return join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "logs");
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
  // Compact JSON: nothing diffs this file (only --continue reads it), and the
  // pretty-printed form was ~30% larger on every per-turn rewrite.
  await Bun.write(path, JSON.stringify(safe));
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

/** Load a specific session by id (for `--resume <id>`), or null if absent. */
export async function loadSession(id: string): Promise<ISessionRecord | null> {
  return readRecord(join(storeDir(), `${id}.json`));
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
        ...optionalSessionFields(data),
      };
    }
  } catch {
    // unreadable / malformed → skip it
  }

  return null;
}

/** Optional resume fields — kept off `readRecord` for the complexity budget. */
function optionalSessionFields(
  data: Record<string, unknown>
): Partial<ISessionRecord> {
  return {
    ...(typeof data.auto === "boolean" ? { auto: data.auto } : {}),
    ...(typeof data.profile === "string" ? { profile: data.profile } : {}),
    ...(data.strictFloorOnly === true
      ? { strictFloorOnly: true as const }
      : {}),
    ...(typeof data.planMode === "boolean" ? { planMode: data.planMode } : {}),
    ...(typeof data.pausedWithEdit === "boolean"
      ? { pausedWithEdit: data.pausedWithEdit }
      : {}),
    ...(Array.isArray(data.touched)
      ? {
          touched: data.touched.filter(
            (f): f is string => typeof f === "string" && f.length > 0
          ),
        }
      : {}),
    ...(data.activePlanId === null || typeof data.activePlanId === "string"
      ? { activePlanId: data.activePlanId }
      : {}),
    ...(typeof data.lastPromptTokens === "number" && data.lastPromptTokens > 0
      ? { lastPromptTokens: data.lastPromptTokens }
      : {}),
  };
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

  // DeepSeek reasoning replay REQUIRES the prior turn's reasoning_content, so it
  // must survive a resume — toMessage previously dropped it on every reload.
  if (typeof raw.reasoningContent === "string") {
    message.reasoningContent = raw.reasoningContent;
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

/** Characters that mark a bare value as a CODE EXPRESSION, not a literal
 *  credential: property access, calls, template/env interpolation, regex/path
 *  slashes, generics. `config.apiKey`, `process.env.API_KEY`,
 *  `localStorage.getItem("t")`, `/x/` are code the model must be able to
 *  round-trip from its own history — redacting them persisted a transcript in
 *  which the model "wrote" files it never wrote, and `--continue` replayed
 *  that as fact (edit oldString copied from redacted history → no match →
 *  repair spin, or "[redacted]" pasted back into a file). */
const CODE_EXPRESSION = /[.()[\]{}$<>/\\]/;

/** Does a `key=` value look like a real secret (vs a type/identifier/expression)? */
function valueLooksSecret(value: string): boolean {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));

  if (quoted) {
    const inner = value.slice(1, -1);

    // A quoted literal credential: non-trivial, a single token (real secrets
    // have no spaces), not a code expression ("${TOKEN}"), and actually
    // credential-SHAPED — symbols beyond identifier chars, or the classic
    // mixed letters+digits blob. A plain quoted word or snake_case identifier
    // (`tokenCap: "max_tokens"`) is ordinary code and must round-trip.
    if (inner.length < 6 || /\s/.test(inner) || CODE_EXPRESSION.test(inner)) {
      return false;
    }

    return (
      /[^A-Za-z0-9_-]/.test(inner) ||
      (/[0-9]/.test(inner) && /[A-Za-z]/.test(inner) && inner.length >= 8)
    );
  }

  // A bare value that reads as code is an expression, never a literal secret.
  if (CODE_EXPRESSION.test(value)) {
    return false;
  }

  // A bare literal: secret-looking if it mixes letters and digits (the classic
  // credential shape) or is long. Short identifiers (`string`, `getInput`) and
  // plain words survive; `hunter2xyz9` and 16+-char blobs do not.
  return (
    (/[A-Za-z]/.test(value) && /[0-9]/.test(value) && value.length >= 8) ||
    value.length >= 16
  );
}

/**
 * Scrub secrets from text before it is persisted (data minimization). Covers
 * private-key blocks, connection-string passwords, `<secret-key>: <value>`
 * assignments (only when the value looks like a real secret), and a battery of
 * known token shapes (OpenAI/Stripe/GitHub/AWS/Google/Slack/npm/JWT/Bearer).
 */
export function redactText(text: string): string {
  let out = redactPreciseSecrets(text);

  out = out.replace(
    SECRET_KEYWORD,
    (match: string, key: string, sep: string, value: string) =>
      valueLooksSecret(value) ? `${key}${sep}${REDACTED}` : match
  );

  return out;
}

/** Only the HIGH-PRECISION patterns (PEM blocks, connection-string passwords,
 *  known token shapes) — no fuzzy `key: value` heuristics. Used for tool-call
 *  args that carry CODE (`create`/`edit` bodies): those are round-tripped
 *  verbatim on resume, so a heuristic false positive there corrupts what the
 *  model believes it wrote. The precise shapes still catch a real token typed
 *  into a file. */
export function redactCodeText(text: string): string {
  return redactPreciseSecrets(text);
}

function redactPreciseSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);

  out = out.replace(CONNECTION_PASSWORD, `$1${REDACTED}$2`);

  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, REDACTED);
  }

  return out;
}

/** Per-message redaction cache. The transcript is APPEND-only between saves,
 *  yet every save re-ran 13 regex passes over EVERY message (quadratic across
 *  a session — tens to hundreds of blocking ms per turn on a long transcript).
 *  Keyed by message identity, revalidated against the content/toolCalls fields
 *  so an in-place edit (compaction rewrites, gate-feedback slots) can never
 *  serve a stale redaction — i.e. never let a new secret through. */
const redactedCache = new WeakMap<
  IChatMessage,
  {
    content: string;
    toolCalls: readonly IToolCall[] | undefined;
    /** Cheap structural stamp over the args — hygiene passes mutate
     *  `tc.arguments` IN PLACE without replacing the array, which array
     *  identity alone cannot see. */
    argsStamp: number;
    redacted: IChatMessage;
  }
>();

/** Total serialized length of the calls' names + string arg values — changes
 *  whenever any in-place args mutation (stubbing, scrubbing) lands. */
function argsStamp(calls: readonly IToolCall[] | undefined): number {
  if (calls === undefined) {
    return -1;
  }

  let n = 0;

  for (const call of calls) {
    n += call.name.length;

    for (const value of Object.values(call.arguments)) {
      n += typeof value === "string" ? value.length : 1;
    }
  }

  return n;
}

/**
 * Redact every message before persisting: its text (user prompts, assistant
 * answers, AND tool output — a `cat .env` dump is a real leak vector) AND the
 * string values inside tool-call arguments (a token pasted into a `run` command
 * or `create` content). Structure is preserved; only string values are scrubbed.
 */
function redactMessages(messages: readonly IChatMessage[]): IChatMessage[] {
  return messages.map((message) => {
    const hit = redactedCache.get(message);

    if (
      hit?.content === message.content &&
      hit.toolCalls === message.toolCalls &&
      hit.argsStamp === argsStamp(message.toolCalls)
    ) {
      return hit.redacted;
    }

    const redacted: IChatMessage = {
      ...message,
      content: redactText(message.content),
      ...(message.toolCalls === undefined
        ? {}
        : { toolCalls: redactToolCalls(message.toolCalls) }),
    };

    redactedCache.set(message, {
      content: message.content,
      toolCalls: message.toolCalls,
      argsStamp: argsStamp(message.toolCalls),
      redacted,
    });

    return redacted;
  });
}

/** Arg keys that carry CODE round-tripped verbatim on resume (`create`/`edit`
 *  bodies and anchors) — heuristic redaction there corrupts the transcript the
 *  model replays; only the precise token shapes apply. */
const CODE_ARG_KEYS = new Set(["content", "oldString", "newString"]);

function redactToolCalls(calls: readonly IToolCall[]): IToolCall[] {
  return calls.map((call) => ({
    ...call,
    arguments: redactArgs(call.arguments),
  }));
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }

    out[key] = CODE_ARG_KEYS.has(key)
      ? redactCodeText(value)
      : redactText(value);
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
