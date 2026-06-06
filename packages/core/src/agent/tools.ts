import type { ICreateFile, IReplacement } from "../files";
import { isArray, isRecord } from "../lib/guards";
import { readProcessOutput } from "../lib/process";

/**
 * The canonical tool names. Schemas, dispatch, and any name comparison reference
 * these — never a bare string literal (so a rename is one edit and typos can't
 * silently miss). The 4 base tools are always offered; the rest are the LSP nav
 * set, gated to existing-code runs (see run.ts toolsFor).
 */
export const TOOL_NAME = {
  read: "read",
  run: "run",
  edit: "edit",
  create: "create",
  search: "search",
  symbolSearch: "symbol_search",
  findReferences: "find_references",
  typeAt: "type_at",
  diagnostics: "diagnostics",
  renameSymbol: "rename_symbol",
  organizeImports: "organize_imports",
} as const;

export type ToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME];

/**
 * Resolve the target file path from a tool call. Our schema asks for `file`, but
 * the model frequently reaches for `path` (the Claude-Code convention) and other
 * synonyms. A schema mismatch on the very FIRST tool call poisons the whole
 * trajectory — observed on react-board: 7 rejected reads in turn 1 sent the
 * model into an inert "let me read…" narration loop that never recovered. So we
 * accept the aliases instead of rejecting (input-repair, per the tooling
 * principle: meet the model where it is). `file` wins if both are present.
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
 * The two file-mutation tools the model is offered. One definition, shared by
 * every caller (the implement agent and test generation) so the contract the
 * model sees can't drift between code paths.
 */
export const EDIT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.edit,
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
    name: TOOL_NAME.create,
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

export const RUN_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.run,
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
    name: TOOL_NAME.read,
    description: "Read a file's current contents from the working directory.",
    parameters: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    },
  },
};

/**
 * Semantic + search tools backed by the in-process TypeScript LanguageService
 * (+ ripgrep). They let the model NAVIGATE and REFACTOR a codebase by symbol
 * name instead of reading whole files — essential at project scale. Read-only
 * tools (find_references, type_at, symbol_search, diagnostics) are unrestricted;
 * the writers (rename_symbol, organize_imports) are scope-enforced in dispatch.
 */
export const LSP_TOOLS = [
  {
    type: "function",
    function: {
      name: TOOL_NAME.search,
      description:
        "ripgrep the working directory for a pattern — your primary way to FIND code without knowing file paths. Returns file:line matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          glob: {
            type: "string",
            description: "optional path glob to scope the search",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.symbolSearch,
      description:
        "Find where a symbol (type/function/const) is declared across the project, by name. Returns kind, name, file:line.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.findReferences,
      description:
        "List every reference to a symbol across the project (semantic, not text). Give the file it's declared/used in and the symbol name.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" }, symbol: { type: "string" } },
        required: ["file", "symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.typeAt,
      description:
        "Get the inferred TypeScript type of a symbol (so you don't guess types). Give the file and symbol name.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" }, symbol: { type: "string" } },
        required: ["file", "symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.diagnostics,
      description:
        "Get the TypeScript semantic diagnostics (type errors) for one file on demand.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.renameSymbol,
      description:
        "Semantically rename a symbol across ALL its references in one step (no manual multi-file edits). Rejected if any reference is in a read-only/out-of-scope file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          symbol: { type: "string" },
          newName: { type: "string" },
        },
        required: ["file", "symbol", "newName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAME.organizeImports,
      description:
        "Sort + dedupe + drop unused imports in an editable file (deterministic).",
      parameters: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"],
      },
    },
  },
];

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
  const { stdout, stderr } = await readProcessOutput(proc.stdout, proc.stderr);

  return { stdout, stderr, exitCode };
}
