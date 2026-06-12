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
  editLines: "edit_lines",
  create: "create",
  search: "search",
  symbolSearch: "symbol_search",
  findReferences: "find_references",
  typeAt: "type_at",
  diagnostics: "diagnostics",
  renameSymbol: "rename_symbol",
  organizeImports: "organize_imports",
  scaffoldUi: "scaffold_ui",
  scaffoldRoutes: "scaffold_routes",
  scaffoldWeb: "scaffold_web",
  addDependency: "add_dependency",
  yieldStatus: "yield_status",
} as const;

/** Tools that cannot mutate the workspace — the PLAN-MODE set. `run` is absent
 *  on purpose: it is special-cased (allowed only for read-only commands — see
 *  isReadOnlyCommand in loop/tools/file-ops). */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.read,
  TOOL_NAME.search,
  TOOL_NAME.symbolSearch,
  TOOL_NAME.findReferences,
  TOOL_NAME.typeAt,
  TOOL_NAME.diagnostics,
]);

/** The model's own decision to start a from-scratch WEB app: scaffolds the stack
 *  (Vite + the chosen framework + deps) and switches the session to the web gate.
 *  Offered on a fresh interactive session so the AGENT decides whether to scaffold
 *  — NOT a brittle classifier. Call it ONLY for "build a web app/UI"; for a
 *  question, a CLI script, or editing code, just do the work directly. */
export const SCAFFOLD_WEB_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.scaffoldWeb,
    description:
      "Start a NEW web application from scratch: scaffolds a Vite project (React full kit — shadcn/ui + TanStack Router + Query — or vanilla TS) with dependencies installed, and switches the build to the web gate (tsc + eslint + vite build + browser render). Call this ONCE, FIRST, ONLY when the user wants you to BUILD a browser app or UI. Do NOT call it for: answering a question, writing a CLI/Node script, printing output (e.g. 'render a table in the CLI'), or editing an existing project — just do those directly. After it returns, write your type contract, then implement the routes/features.",
    parameters: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          enum: ["react", "vanilla"],
          description:
            "react = full kit (shadcn/ui + TanStack Router + Query); vanilla = Vite + TypeScript + Tailwind. Default react.",
        },
      },
      required: ["framework"],
    },
  },
};

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

export const EDIT_LINES_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.editLines,
    description:
      "Edit file lines by content hash (stale-anchor recovery). Copy the hash from the read output (¶path#HASH), then use: ¶path#HASH / replace N..M: +line1 +line2 / delete N..M / insert before|after N: +line.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        hash: {
          type: "string",
          description: "optional: file content hash (¶path#HASH)",
        },
        input: { type: "string", description: "hashline edit operations" },
      },
      required: ["file", "input"],
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
      "Generate tested, accessible UI building blocks into src/components/ui/, styled to a chosen vibe — so you NEVER hand-write base components or view chrome. Two tiers: PRIMITIVES (button, card, input, label, textarea, select, badge, separator, table) and COMPOSITION BLOCKS (app-shell = sidebar+nav layout, page-header, field = label+control+error, form-actions, toolbar, empty-state). Call this ONCE near the start with everything the app needs, then import and COMPOSE: e.g. build a list view from page-header + toolbar + table, a form from field + form-actions, the layout from app-shell. NEVER hand-roll these; it wastes time and breaks theme coherence. Also writes the matching design tokens into src/index.css.",
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
              "app-shell",
              "page-header",
              "field",
              "form-actions",
              "toolbar",
              "empty-state",
            ],
          },
          description: "Which building blocks to generate.",
        },
      },
      required: ["theme", "components"],
    },
  },
};

/** Materialize ALL of an app's routes as working file-based stubs in one call,
 *  from a model-declared list of paths — so the route union is complete up front
 *  and no `<Link>` can forward-reference a missing route. Web builds only. */
export const SCAFFOLD_ROUTES_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.scaffoldRoutes,
    description:
      "Create ALL the app's pages as TanStack file-based route STUBS in one call — you give the list of route paths your app needs (from the user's request); the harness writes each src/routes/*.tsx with a correct createFileRoute() and a placeholder component, and regenerates the route tree. Call this ONCE, right after your types + data services, with EVERY page the app needs — list pages, detail pages (use $param, e.g. /accounts/$accountId), and create/edit pages (e.g. /deals/create). After this, every route exists, the app navigates, and every <Link to>/navigate target type-checks — so you can build components in any order without 'not assignable to route' errors. Then FILL each route's component (replace the placeholder) one feature at a time. Do NOT hand-write route files or call this per-route.",
    parameters: {
      type: "object",
      properties: {
        routes: {
          type: "array",
          items: { type: "string" },
          description:
            'Every page path the app needs, e.g. ["/", "/accounts", "/accounts/$accountId", "/accounts/create", "/settings/profile"].',
        },
      },
      required: ["routes"],
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
/** The STOP tool for forced-tools mode (TSFORGE_FORCE_TOOLS): with tool_choice
 *  "required" the model can never end a turn in prose, so this is how it stops —
 *  every turn is grammar-constrained and the malformed-call class is impossible.
 *  The session converts a yield_status call back into a normal "model stopped"
 *  turn (summary becomes the reply; the gate confirms as usual). */
export const YIELD_STATUS_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.yieldStatus,
    description:
      "Call this when you are DONE working on the request (or have a final answer/question for the user) — it ends your turn. Put your reply in `summary`. Do not call it together with other tools; finish the work first.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "your reply to the user: what you did, or your answer/question",
        },
      },
      required: ["summary"],
    },
  },
};

/** Install npm packages with bun — the measured next frontier blocker (builds
 *  dead-ended whenever a feature needed a dep the scaffold didn't ship). Names
 *  are validated handler-side (no flags/shell metacharacters reach the shell). */
export const ADD_DEPENDENCY_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.addDependency,
    description:
      "Install one or more npm packages into this project (bun add). Use it when a feature genuinely needs a library the project doesn't have — check package.json first. Plain package names only (e.g. 'date-fns' or 'zod@3'), no flags.",
    parameters: {
      type: "object",
      properties: {
        packages: {
          type: "string",
          description:
            "space-separated package names, each optionally @versioned, e.g. 'date-fns zod@3'",
        },
        dev: {
          type: "boolean",
          description: "install as devDependency (default false)",
        },
      },
      required: ["packages"],
    },
  },
};

/** Ripgrep over the workspace — read-only, deps-free, and useful WITHOUT a
 *  tsconfig, so it is also offered standalone in interactive sessions (the
 *  plan-mode explorer's main tool besides `read`). */
export const SEARCH_TOOL = {
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
};

export const LSP_TOOLS = [
  SEARCH_TOOL,
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
