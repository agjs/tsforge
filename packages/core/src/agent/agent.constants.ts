import type { ToolName } from "./agent.types";
import type { IAgentSpec } from "./agent-spec";

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
  moveFile: "move_file",
  organizeImports: "organize_imports",
  gitContext: "git_context",
  scaffoldUi: "scaffold_ui",
  scaffoldRoutes: "scaffold_routes",
  scaffoldWeb: "scaffold_web",
  addDependency: "add_dependency",
  packageInfo: "package_info",
  packageDocs: "package_docs",
  webFetch: "web_fetch",
  webSearch: "web_search",
  webBrowse: "web_browse",
  script: "script",
  spawnAgent: "spawn_agent",
  readImage: "read_image",
  generateImage: "generate_image",
} as const;

/** Per-tool capability flags — the single source of truth the plan-mode set and
 *  the script-exposable subset are derived from (so a new tool declares its
 *  behaviour ONCE here instead of being added to several hand-kept sets).
 *  - `readOnly`: cannot mutate the workspace ⇒ allowed in plan mode. `run` is
 *    deliberately false: it is special-cased (allowed only for read-only
 *    commands — see isReadOnlyCommand in loop/tools/file-ops).
 *  - `scriptExposable`: safe + useful to call from inside a `script` program via
 *    the generated RPC stubs. Excludes the heavy/interactive scaffolds, the
 *    dependency installer, and `script` itself (no recursion). Mutating tools
 *    (edit/create/…) ARE exposable — they still flow
 *    back through executeTool's scope + write-guard + gate. */
export interface IToolSpec {
  readOnly: boolean;
  scriptExposable: boolean;
}

export const TOOL_SPECS: Readonly<Record<ToolName, IToolSpec>> = {
  [TOOL_NAME.read]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.run]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.edit]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.editLines]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.create]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.search]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.symbolSearch]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.findReferences]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.typeAt]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.diagnostics]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.renameSymbol]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.moveFile]: { readOnly: false, scriptExposable: true },
  [TOOL_NAME.organizeImports]: { readOnly: false, scriptExposable: true },
  // git_context only inspects history/diffs — no workspace mutation — so it is a
  // plan-mode tool too (scope a review/fix while planning, before any edit).
  [TOOL_NAME.gitContext]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.scaffoldUi]: { readOnly: false, scriptExposable: false },
  [TOOL_NAME.scaffoldRoutes]: { readOnly: false, scriptExposable: false },
  [TOOL_NAME.scaffoldWeb]: { readOnly: false, scriptExposable: false },
  [TOOL_NAME.addDependency]: { readOnly: false, scriptExposable: false },
  [TOOL_NAME.packageInfo]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.packageDocs]: { readOnly: true, scriptExposable: true },
  // Web tools are read-only (no workspace mutation), so they're usable in plan
  // mode too — research while planning. Network egress here is structured and
  // opt-in (TSFORGE_WEB), unlike the raw `run` curl path plan mode blocks.
  [TOOL_NAME.webFetch]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.webSearch]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.webBrowse]: { readOnly: true, scriptExposable: true },
  // `script` mutates (it can call edit/create) and must never call itself.
  [TOOL_NAME.script]: { readOnly: false, scriptExposable: false },
  // Delegation is itself read-only (the orchestrator only receives findings;
  // spawned agents cannot mutate), so it survives plan mode. NOT script-exposable
  // (no spawning from a program) and — by construction — never offered to a
  // spawned agent, which caps recursion depth at 1 (see agent-runner agentTools).
  [TOOL_NAME.spawnAgent]: { readOnly: true, scriptExposable: false },
  // Vision reading is a read-only network call (no workspace mutation) → usable
  // while planning. Image GENERATION writes a file to disk, so it is not read-only
  // and is withheld in plan mode. Both are gated on a configured capability
  // backend (see toolsFor). Not script-exposable initially (network + I/O heavy).
  [TOOL_NAME.readImage]: { readOnly: true, scriptExposable: false },
  [TOOL_NAME.generateImage]: { readOnly: false, scriptExposable: false },
};

function toolNamesWhere(
  pick: (spec: IToolSpec) => boolean
): ReadonlySet<string> {
  const names = new Set<string>();

  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    if (pick(spec)) {
      names.add(name);
    }
  }

  return names;
}

/** Tools that cannot mutate the workspace — the PLAN-MODE set (derived from
 *  TOOL_SPECS). `run` is absent on purpose (special-cased; see above). */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = toolNamesWhere(
  (spec) => spec.readOnly
);

/** Tools the model may call from inside a `script` program (derived). */
export const SCRIPT_EXPOSABLE_TOOLS: ReadonlySet<string> = toolNamesWhere(
  (spec) => spec.scriptExposable
);

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

/** Free, LOCAL web access (gated behind TSFORGE_WEB). web_fetch reads a known
 *  URL; web_search discovers URLs. No API key, no paid service — fetch extracts
 *  on-machine, search uses DuckDuckGo (or a self-hosted SearXNG). */
export const WEB_FETCH_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.webFetch,
    description:
      "Fetch a public web page and get its main content back as readable markdown. Use it to READ a known URL — docs, a GitHub issue, an RFC, an API reference — instead of guessing. Give the absolute http(s) URL; returns the extracted article text (truncated — pass `maxChars` for more). Runs locally on the user's machine; no external API or key.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "absolute http(s) URL to fetch" },
        maxChars: {
          type: "number",
          description: "optional cap on returned characters (default 8000)",
        },
      },
      required: ["url"],
    },
  },
};

export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.webSearch,
    description:
      "Search the web and get back ranked public result titles, URLs, and snippets. Use it to DISCOVER current sources when you don't already have a URL, then `web_fetch` the most relevant one. Supports `recency` for fresh docs/news, `domains` for official-site scoping, and `maxResults` for broader source discovery. Free and keyless — DuckDuckGo by default, or a user-run SearXNG instance via TSFORGE_SEARXNG_URL. Set TSFORGE_WEB_SEARCH_BACKEND=searxng to fail closed instead of falling back to DuckDuckGo.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "the search query" },
        recency: {
          type: "string",
          enum: ["day", "month", "year"],
          description:
            "optional freshness window for fast-moving topics and current docs",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            "optional public hostnames to search within, e.g. ['typescriptlang.org', 'nodejs.org']",
        },
        maxResults: {
          type: "number",
          description:
            "optional result cap (default 8, maximum 20) when comparing multiple sources",
        },
      },
      required: ["query"],
    },
  },
};

export const WEB_BROWSE_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.webBrowse,
    description:
      "Open a public URL in a local headless Chromium browser via Playwright and return rendered visible text, final URL, title, and links. Use it when docs/sites require JavaScript or when web_fetch misses content. No hosted browser service or API key.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "absolute http(s) URL to open in the local browser",
        },
        waitMs: {
          type: "number",
          description:
            "optional extra wait after DOMContentLoaded for client-rendered docs (default 750, max 10000)",
        },
        maxChars: {
          type: "number",
          description: "optional cap on returned visible text (default 10000)",
        },
      },
      required: ["url"],
    },
  },
};

export const PACKAGE_INFO_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.packageInfo,
    description:
      "Read current npm package metadata from the configured npm registry with no API key: latest dist-tag, versions, deprecation, peer deps, homepage, repository, and dependency names. Use before installing or coding against a package API.",
    parameters: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description:
            "one npm package name, optionally @versioned, e.g. 'zod', 'react@19', '@tanstack/react-query'",
        },
        maxChars: {
          type: "number",
          description: "optional cap on returned characters (default 12000)",
        },
      },
      required: ["package"],
    },
  },
};

export const PACKAGE_DOCS_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.packageDocs,
    description:
      "Read package documentation with no paid service: local node_modules README/package.json/types first, then npm registry README when needed. Use this for version-aware package docs before guessing APIs.",
    parameters: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description:
            "one npm package name, optionally @versioned, e.g. 'zod@4' or '@tanstack/react-query'",
        },
        source: {
          type: "string",
          enum: ["auto", "local", "registry"],
          description:
            "auto prefers installed local docs, local refuses network, registry uses npm metadata",
        },
        maxChars: {
          type: "number",
          description: "optional cap on returned characters (default 12000)",
        },
      },
      required: ["package"],
    },
  },
};

/** Programmatic Tool Calling: the model writes ONE TypeScript program that calls
 *  tools through generated stubs, collapsing a multi-step tool chain into a single
 *  turn. ON by default (withhold with TSFORGE_NO_SCRIPT) and withheld in plan mode (it can write). */
export const SCRIPT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.script,
    description:
      "Run ONE TypeScript program that calls tools via stubs imported from `./tsforge-tools`, instead of many separate tool turns. Best for repetitive multi-step work — read/scan many files, fetch+compare several packages, transform-then-write across files. Each stub (e.g. `read`, `run`, `web_search`, `edit`, `create`) is async and returns the tool's text result; only your script's stdout (use console.log) comes back to you. File changes MUST go through the `edit`/`create` stubs (not direct fs writes) so they pass the scope + type/lint gate. Bounded by a wall-clock timeout and a tool-call cap.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "the TypeScript program; `import { read, run, web_search, edit, create } from './tsforge-tools'` and console.log what you want returned",
        },
        timeoutMs: {
          type: "number",
          description:
            "optional wall-clock budget in ms (default 60000, max 300000)",
        },
      },
      required: ["code"],
    },
  },
};

/**
 * Semantic + search tools backed by the in-process TypeScript LanguageService
 * (+ ripgrep). Read-only tools (find_references, type_at, symbol_search,
 * diagnostics) are unrestricted; the writers (rename_symbol, organize_imports)
 * are scope-enforced in dispatch.
 */
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
  {
    type: "function",
    function: {
      name: TOOL_NAME.moveFile,
      description:
        "Move/rename a FILE and rewrite every import that points at it (and its own relative imports) in one step — compiler-accurate, no manual edits. Rejected if the source, destination, or any importer is read-only/out-of-scope.",
      parameters: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
  },
];

/** Read-only, structured git introspection — scope a review or a fix to what
 *  actually changed. Wraps the `git` binary via an explicit argv (no shell); the
 *  op is a fixed read-only allowlist. Offered on existing-code runs (gated like
 *  the nav set; greenfield has no history). TSFORGE_NO_GIT_TOOL forces it off. */
export const GIT_CONTEXT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.gitContext,
    description:
      "Inspect the repository's git state (read-only) to scope your work to what changed. ops: 'diff' (working-tree or staged changes, optionally vs a ref, optionally a path), 'changed_files' (files changed with +adds/-dels), 'log' (recent commits; pass path + lineStart/lineEnd for a line range's history), 'blame' (who last touched a line range — needs path), 'show' (a commit's message + diff — needs sha).",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["diff", "changed_files", "log", "blame", "show"],
        },
        ref: {
          type: "string",
          description:
            "git ref to compare against (e.g. main, HEAD~3); default is the working tree",
        },
        path: { type: "string", description: "limit to a file or directory" },
        sha: { type: "string", description: "commit SHA (for op 'show')" },
        staged: {
          type: "boolean",
          description: "diff the staged index instead of the working tree",
        },
        lineStart: { type: "number", description: "start line (blame / log)" },
        lineEnd: { type: "number", description: "end line (blame / log)" },
        max: {
          type: "number",
          description: "max commits for op 'log' (default 15)",
        },
        maxChars: {
          type: "number",
          description: "cap on returned characters (default 4000)",
        },
      },
      required: ["op"],
    },
  },
};

/** Vision (image reading) — offered only when a `vision` capability backend is
 *  configured (`~/.tsforge/models.json` `capabilities.vision` or a
 *  `TSFORGE_VISION_*` env). The primary chat model is text-only, so this delegates
 *  to that backend and returns a text description the model can act on. */
export const READ_IMAGE_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.readImage,
    description:
      "Look at an image file in the workspace and get back a text description/answer. Use it to understand a screenshot, mockup, diagram, or photo — pass the path and, optionally, a specific question (e.g. 'what error does this show?'). Routes to the configured vision model; returns text only.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "path to the image file (png/jpeg/webp/gif), relative to the working directory",
        },
        question: {
          type: "string",
          description:
            "optional specific question about the image; omit for a general description",
        },
      },
      required: ["file"],
    },
  },
};

/** Image generation — offered only when an `imageGen` capability backend is
 *  configured. Saves the result under `.tsforge/images/` and returns the path (and
 *  previews it inline in a supporting terminal). */
export const GENERATE_IMAGE_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.generateImage,
    description:
      "Generate an image from a text prompt and save it to .tsforge/images/. Use it when the user asks for an image/asset/illustration. Returns the saved file path; the image is previewed inline in terminals that support it. Routes to the configured image model.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "a detailed description of the image to generate",
        },
        size: {
          type: "string",
          description:
            "optional WxH hint, e.g. '1024x1024' (honored by some backends)",
        },
      },
      required: ["prompt"],
    },
  },
};

/**
 * The model-invoked delegation tool (like Claude Code's Task tool). The
 * orchestrator calls it — the user never names an agent — to hand a focused,
 * self-contained, read-only investigation to a specialist and get its findings
 * back. Multiple calls in one turn run in parallel (see runToolCalls). The
 * `subagent_type` enum is built from the loaded specs so the model sees exactly
 * which specialists exist. Returns null when no specs are available (nothing to
 * delegate to), so the caller offers the tool only when it's useful.
 */
export function buildSpawnAgentTool(specs: readonly IAgentSpec[]): {
  type: "function";
  function: { name: string } & Record<string, unknown>;
} | null {
  if (specs.length === 0) {
    return null;
  }

  const ids = specs.map((s) => s.id);
  const roster = specs
    .map((s) =>
      s.description === undefined ? s.id : `${s.id} (${s.description})`
    )
    .join("; ");

  return {
    type: "function",
    function: {
      name: TOOL_NAME.spawnAgent,
      description:
        "Delegate a focused, READ-ONLY investigation to a specialist subagent and get its findings back as the tool result. Spawn one per independent line of inquiry — several in the same turn run in PARALLEL, each with its own fresh context, and only YOU (the orchestrator) edit files. Use it to explore an unfamiliar subsystem, research external docs/APIs, or verify a claim, without spending your own context on the digging. The subagent does NOT see this conversation, so put everything it needs in `prompt`. " +
        `Available specialists: ${roster}.`,
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            enum: ids,
            description: "which specialist to delegate to",
          },
          description: {
            type: "string",
            description:
              "a 3-5 word label for this subtask, shown in the live agent tree (e.g. 'trace auth flow')",
          },
          prompt: {
            type: "string",
            description:
              "the complete, self-contained task for the subagent — it cannot see this conversation, so include the goal and any file paths or context it needs",
          },
        },
        required: ["subagent_type", "description", "prompt"],
      },
    },
  };
}
