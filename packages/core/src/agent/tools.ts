import type { ICreateFile, IReplacement } from "../files/types";
import { isArray, isRecord } from "../lib/guards";

/**
 * The two file-mutation tools the model is offered. One definition, shared by
 * every caller (the implement agent and test generation) so the contract the
 * model sees can't drift between code paths.
 */
export const EDIT_TOOL = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace an exact, unique snippet in an existing file.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["file", "oldString", "newString"],
    },
  },
};

export const CREATE_TOOL = {
  type: "function",
  function: {
    name: "create",
    description: "Create a new file with the given content.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        content: { type: "string" },
      },
      required: ["file", "content"],
    },
  },
};

/**
 * Normalize either edit form into a file + ordered replacement list. Accepts the
 * single `{file, oldString, newString}` shape AND the batched `{file, edits:[…]}`
 * shape, so old callers and the multi-site path share one contract.
 */
export function toEdits(
  args: Record<string, unknown>
): { file: string; edits: IReplacement[] } | null {
  const { file, edits, oldString, newString } = args;

  if (typeof file !== "string") {
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
  const { file, content } = args;

  if (typeof file === "string" && typeof content === "string") {
    return { file, content };
  }

  return null;
}

export const RUN_TOOL = {
  type: "function",
  function: {
    name: "run",
    description:
      "Run a shell command in the working directory and get its stdout/stderr/exit code. Use this to run the acceptance command, `tsc`, `eslint`, or `bun test` and see the real result — don't guess whether your code passes.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

export const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file's current contents from the working directory.",
    parameters: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    },
  },
};

export function toRun(
  args: Record<string, unknown>
): { command: string } | null {
  const { command } = args;

  return typeof command === "string" ? { command } : null;
}

export function toRead(args: Record<string, unknown>): { file: string } | null {
  const { file } = args;

  return typeof file === "string" ? { file } : null;
}

export interface IShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { stdout, stderr, exitCode };
}
