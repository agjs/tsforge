import type { ICreateFile, IReplacement } from "../files";
import { isArray, isRecord } from "../lib/guards";
import { runShellCommand, runArgvCommand } from "../lib/fs";
import { coerceStringToArray, trimMarkdownFences } from "./tool-repair";
import type { IShellResult } from "./agent.types";

/** Default kill-timeout for the `run` tool (ms) — generous enough for a slow
 *  test/build, short enough that a hung `tail -f`/`vite dev` can't wedge the
 *  harness forever. Override per-process with TSFORGE_RUN_TIMEOUT_MS (0 = off). */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

function runToolTimeoutMs(): number {
  const env = Number(process.env.TSFORGE_RUN_TIMEOUT_MS);

  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_RUN_TIMEOUT_MS;
}

/** Arg keys that may carry the target file path. Our schema asks for `file`, but
 *  models reach for `path` (the Claude-Code convention) and other synonyms. This
 *  is the SINGLE source of truth for which keys name a file: the handlers resolve
 *  the path from it (`fileArg`) AND the policy layer extracts paths from it
 *  (`fileArgCandidates`), so a deny can't be dodged with an alias the policy
 *  doesn't inspect. `file` wins if present (first in the list). */
export const FILE_ARG_KEYS: readonly string[] = [
  "file",
  "path",
  "filename",
  "filepath",
  "filePath",
];

/** Every present file-path value from a tool call, in `FILE_ARG_KEYS` order,
 *  with the same L1 coercions `fileArg` applies (markdown-fence trim, stringified
 *  string). The policy layer uses this so it sees EVERY path the handler could
 *  resolve — not just the schema's `file` — closing alias-based deny bypasses. */
export function fileArgCandidates(args: Record<string, unknown>): string[] {
  const out: string[] = [];

  for (const key of FILE_ARG_KEYS) {
    const value = args[key];

    if (value === undefined || value === null) {
      continue;
    }

    // L1: trim markdown fences (```path.ts``` → path.ts)
    const trimmed = trimMarkdownFences(value);

    if (trimmed !== null && trimmed.length > 0) {
      out.push(trimmed);
      continue;
    }

    // Already a string but not markdown-wrapped.
    if (typeof value === "string" && value.length > 0) {
      out.push(value);
    }
  }

  return out;
}

/**
 * Resolve the target file path from a tool call — the first present alias (so
 * `file` wins), or null. A schema mismatch on the very FIRST tool call poisons
 * the whole trajectory — observed on react-board: 7 rejected reads in turn 1
 * sent the model into an inert "let me read…" loop. So we accept the aliases
 * instead of rejecting (input-repair: meet the model where it is).
 */
export function fileArg(args: Record<string, unknown>): string | null {
  return fileArgCandidates(args)[0] ?? null;
}

/** Content-body aliases — schema asks for `content`, models send these. */
const CONTENT_ARG_KEYS: readonly string[] = [
  "content",
  "contents",
  "body",
  "text",
  "code",
  "source",
];

/** Resolve create body text from `content` or a known synonym. */
export function contentArg(args: Record<string, unknown>): string | null {
  for (const key of CONTENT_ARG_KEYS) {
    const value = args[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function stringField(
  args: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = args[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

/**
 * Normalize either edit form into a file + ordered replacement list. Accepts the
 * single `{file, oldString, newString}` shape AND the batched `{file, edits:[…]}`
 * shape, so old callers and the multi-site path share one contract.
 * Applies L1 coercions: stringified arrays are parsed; snake_case old/new accepted.
 */
export function toEdits(
  args: Record<string, unknown>
): { file: string; edits: IReplacement[] } | null {
  const { edits: editsDef } = args;
  let edits = editsDef;
  const file = fileArg(args);
  const oldStr = stringField(args, ["oldString", "old_string"]);
  const newStr = stringField(args, ["newString", "new_string"]);

  if (file === null) {
    return null;
  }

  // L1: Coerce stringified arrays (e.g. from models that emit '[{...}]' as a string).
  if (typeof edits === "string") {
    const parsed = coerceStringToArray(edits);

    if (parsed !== null) {
      edits = parsed;
    }
  }

  if (isArray(edits)) {
    const list: IReplacement[] = [];

    for (const e of edits) {
      if (!isRecord(e)) {
        return null;
      }

      const oldS = stringField(e, ["oldString", "old_string"]);
      const newS = stringField(e, ["newString", "new_string"]);

      if (oldS === null || newS === null) {
        return null;
      }

      list.push({ oldString: oldS, newString: newS });
    }

    return list.length > 0 ? { file, edits: list } : null;
  }

  if (oldStr !== null && newStr !== null) {
    return { file, edits: [{ oldString: oldStr, newString: newStr }] };
  }

  return null;
}

export function toCreate(args: Record<string, unknown>): ICreateFile | null {
  const file = fileArg(args);
  const content = contentArg(args);

  if (file !== null && content !== null) {
    return { file, content };
  }

  return null;
}

/** True when args carry a real create body (not just a history stub). */
export function hasCreatePayload(args: Record<string, unknown>): boolean {
  return contentArg(args) !== null;
}

/** True when args carry a real edit payload (single or batched). */
export function hasEditPayload(args: Record<string, unknown>): boolean {
  if (toEdits(args) !== null) {
    return true;
  }

  // toEdits needs file; payload alone still counts for history-meta gating.
  const oldStr = stringField(args, ["oldString", "old_string"]);
  const newStr = stringField(args, ["newString", "new_string"]);

  if (oldStr !== null && newStr !== null) {
    return true;
  }

  const { edits } = args;

  return isArray(edits) || typeof edits === "string";
}

/**
 * Field-level L3 feedback when create args still don't parse. Names keys the
 * model sent so it stops blind-retrying the same shape (Shiphold: 22× create
 * rejects with only "need file, content").
 */
export function diagnoseCreateArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  const have = keys.length > 0 ? keys.join(", ") : "(none)";
  const missing: string[] = [];

  if (fileArg(args) === null) {
    missing.push("file");
  }

  if (contentArg(args) === null) {
    missing.push("content");
  }

  const miss =
    missing.length > 0 ? missing.join(" + ") : "file + content (wrong types)";

  return (
    `create: malformed args — have {${have}}; need ${miss}. ` +
    `Example: {file:"src/a.ts", content:"export {}\\n"}. ` +
    `Do not nest under arguments; history stubs are not valid writes.`
  );
}

/**
 * Field-level L3 feedback when edit args still don't parse.
 */
export function diagnoseEditArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  const have = keys.length > 0 ? keys.join(", ") : "(none)";
  const missing: string[] = [];

  if (fileArg(args) === null) {
    missing.push("file");
  }

  const hasPair =
    stringField(args, ["oldString", "old_string"]) !== null &&
    stringField(args, ["newString", "new_string"]) !== null;
  const hasEdits =
    isArray(args.edits) ||
    (typeof args.edits === "string" && args.edits.length > 0);

  if (!hasPair && !hasEdits) {
    missing.push("oldString/newString (or edits[])");
  }

  const miss =
    missing.length > 0
      ? missing.join(" + ")
      : "file + oldString/newString (wrong types)";

  return (
    `edit: malformed args — have {${have}}; need ${miss}. ` +
    `Example: {file:"src/a.ts", oldString:"x", newString:"y"}. ` +
    `Do not nest under arguments; history stubs are not valid writes.`
  );
}

/**
 * Build L3 re-ask feedback for a broken tool call. Targets the exact field,
 * shows what was received, names the expected type, and provides a working example.
 */
export function buildRepairFeedback(
  toolName: string,
  field: string,
  received: unknown,
  expectedType: string,
  example: string
): string {
  return (
    `\n\n⚠ Tool argument repair failed — the \`${toolName}\` tool cannot proceed ` +
    `without fixing \`${field}\`:\n` +
    `  received: ${JSON.stringify(received)} (${typeof received})\n` +
    `  expected: ${expectedType}\n` +
    `  example: \`${example}\`\n\n` +
    `Fix the argument and call the tool again.`
  );
}

export function toRun(
  args: Record<string, unknown>
): { command: string } | null {
  const { command } = args;

  return typeof command === "string" ? { command } : null;
}

export function toRead(args: Record<string, unknown>): { file: string } | null {
  const file = fileArg(args);

  return file !== null ? { file } : null;
}

/**
 * Parse hashline edit args: file (required), hash (optional), input (required).
 */
export function toHashlineEdit(
  args: Record<string, unknown>
): { file: string; hash?: string; input: string } | null {
  const file = fileArg(args);
  const { hash, input } = args;

  if (file === null || typeof input !== "string" || input.length === 0) {
    return null;
  }

  const hashStr =
    typeof hash === "string" && hash.length > 0 ? hash : undefined;

  return { file, hash: hashStr, input };
}

/** Run a shell command in `cwd` and capture stdout/stderr/exit — the `run` tool.
 *  Cancellable via `signal`; killed after a timeout (default `runToolTimeoutMs`)
 *  so a hung command can't wedge the harness. A timeout appends a clear note. */
export async function runCommand(
  cwd: string,
  command: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<IShellResult> {
  const timeoutMs = opts.timeoutMs ?? runToolTimeoutMs();
  const run = await runShellCommand(cwd, command, {
    timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const note = run.timedOut
    ? `\n[command killed after ${timeoutMs}ms timeout — TSFORGE_RUN_TIMEOUT_MS to change]`
    : "";

  return {
    stdout: run.stdout,
    stderr: run.stderr + note,
    exitCode: run.exitCode,
  };
}

/** Like `runCommand` but spawns an explicit argv with NO shell, so arguments are
 *  passed literally and can't be expanded/redirected/injected. Use this whenever
 *  any argument is built from model- or content-supplied text (e.g. `bun add
 *  <pkg>`). Same timeout/abort semantics and timeout note as `runCommand`. */
export async function runArgv(
  cwd: string,
  argv: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<IShellResult> {
  const timeoutMs = opts.timeoutMs ?? runToolTimeoutMs();
  const run = await runArgvCommand(cwd, argv, {
    timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const note = run.timedOut
    ? `\n[command killed after ${timeoutMs}ms timeout — TSFORGE_RUN_TIMEOUT_MS to change]`
    : "";

  return {
    stdout: run.stdout,
    stderr: run.stderr + note,
    exitCode: run.exitCode,
  };
}
