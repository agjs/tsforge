import type { ICreateFile, IReplacement } from "../files";
import { isArray, isRecord } from "../lib/guards";
import { readProcessOutput } from "../lib/fs";
import type { IShellResult } from "./agent.types";

/**
 * Resolve the target file path from a tool call. Our schema asks for `file`, but
 * the model frequently reaches for `path` (the Claude-Code convention) and other
 * synonyms. A schema mismatch on the very FIRST tool call poisons the whole
 * trajectory — observed on react-board: 7 rejected reads in turn 1 sent the
 * model into an inert "let me read…" loop. So we accept the aliases instead of
 * rejecting (input-repair: meet the model where it is). `file` wins if present.
 */
export function fileArg(args: Record<string, unknown>): string | null {
  for (const key of ["file", "path", "filename", "filepath", "filePath"]) {
    const value = args[key];

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
 */
export function toEdits(
  args: Record<string, unknown>
): { file: string; edits: IReplacement[] } | null {
  const { edits, oldString, newString } = args;
  const file = fileArg(args);

  if (file === null) {
    return null;
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

  if (typeof oldString === "string" && typeof newString === "string") {
    return { file, edits: [{ oldString, newString }] };
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

/** Run a shell command in `cwd` and capture stdout/stderr/exit — the `run` tool. */
export async function runCommand(
  cwd: string,
  command: string
): Promise<IShellResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const { stdout, stderr } = await readProcessOutput(proc.stdout, proc.stderr);

  return { stdout, stderr, exitCode };
}
