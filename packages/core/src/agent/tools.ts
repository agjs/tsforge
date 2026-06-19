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

/**
 * Resolve the target file path from a tool call. Our schema asks for `file`, but
 * the model frequently reaches for `path` (the Claude-Code convention) and other
 * synonyms. A schema mismatch on the very FIRST tool call poisons the whole
 * trajectory — observed on react-board: 7 rejected reads in turn 1 sent the
 * model into an inert "let me read…" loop. So we accept the aliases instead of
 * rejecting (input-repair: meet the model where it is). `file` wins if present.
 * Also applies L1 coercions: trims markdown fences, coerces if stringified.
 */
export function fileArg(args: Record<string, unknown>): string | null {
  for (const key of ["file", "path", "filename", "filepath", "filePath"]) {
    const value = args[key];

    if (value === undefined || value === null) {
      continue;
    }

    // L1: trim markdown fences (```path.ts``` → path.ts)
    const trimmed = trimMarkdownFences(value);

    if (trimmed !== null && trimmed.length > 0) {
      return trimmed;
    }

    // Already a string but not markdown-wrapped.
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

/**
 * Normalize either edit form into a file + ordered replacement list. Accepts the
 * single `{file, oldString, newString}` shape AND the batched `{file, edits:[…]}`
 * shape, so old callers and the multi-site path share one contract.
 * Applies L1 coercions: stringified arrays are parsed.
 */
export function toEdits(
  args: Record<string, unknown>
): { file: string; edits: IReplacement[] } | null {
  const { edits: editsDef, oldString: oldStr, newString: newStr } = args;
  let edits = editsDef;
  const file = fileArg(args);

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
      if (
        isRecord(e) &&
        typeof e.oldString === "string" &&
        typeof e.newString === "string"
      ) {
        list.push({ oldString: e.oldString, newString: e.newString });
      } else {
        return null;
      }
    }

    return list.length > 0 ? { file, edits: list } : null;
  }

  if (typeof oldStr === "string" && typeof newStr === "string") {
    return { file, edits: [{ oldString: oldStr, newString: newStr }] };
  }

  return null;
}

export function toCreate(args: Record<string, unknown>): ICreateFile | null {
  const { content } = args;
  const file = fileArg(args);

  if (file !== null && typeof content === "string") {
    return { file, content };
  }

  return null;
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
