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
  scaffoldUi: "scaffold_ui",
} as const;

/** The two file-mutation tools the model is always offered. */
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

/** Materialize tested, THEMED UI primitives (button/card/input/…) into
 *  src/components/ui/ so you never hand-write a base component. Web builds only. */
export const SCAFFOLD_UI_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.scaffoldUi,
    description:
      "Generate tested, accessible UI primitives (button, card, input, label, textarea, select, badge, separator, table) into src/components/ui/, styled to a chosen vibe. Call this ONCE near the start with the primitives the app needs — then import and compose them. NEVER hand-write these base components yourself; that wastes time and they won't match the theme. It also writes the matching design tokens into src/index.css.",
    parameters: {
      type: "object",
      properties: {
        theme: {
          type: "string",
          enum: ["minimal", "warm", "futuristic"],
          description: "The visual vibe, derived from the user's request.",
        },
        components: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "button",
              "card",
              "input",
              "label",
              "textarea",
              "select",
              "badge",
              "separator",
              "table",
            ],
          },
          description: "Which primitives to generate.",
        },
      },
      required: ["theme", "components"],
    },
  },
};

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
 * (+ ripgrep). Read-only tools (find_references, type_at, symbol_search,
 * diagnostics) are unrestricted; the writers (rename_symbol, organize_imports)
 * are scope-enforced in dispatch.
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
