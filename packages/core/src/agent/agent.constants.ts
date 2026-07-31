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
  addDependency: "add_dependency",
  packageInfo: "package_info",
  packageDocs: "package_docs",
  pullConventions: "pull_conventions",
  webFetch: "web_fetch",
  webSearch: "web_search",
  webBrowse: "web_browse",
  script: "script",
  spawnAgent: "spawn_agent",
  readImage: "read_image",
  generateImage: "generate_image",
  check: "check",
  askUser: "ask_user",
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
  [TOOL_NAME.addDependency]: { readOnly: false, scriptExposable: false },
  [TOOL_NAME.packageInfo]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.packageDocs]: { readOnly: true, scriptExposable: true },
  [TOOL_NAME.pullConventions]: { readOnly: true, scriptExposable: true },
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
  // `check` runs the gate, which applies the workspace's deterministic auto-fixes
  // (prettier / eslint --fix) — so it can mutate → NOT plan-mode-safe. Not script-
  // exposable: the gate is heavy and already runs at end-of-turn.
  [TOOL_NAME.check]: { readOnly: false, scriptExposable: false },
  // `ask_user` asks the human ONE bounded question and mutates nothing — plan-mode
  // safe (clarifying while planning is fine). Not script-exposable: it's an
  // interactive control-flow tool, not a data call a program should make.
  [TOOL_NAME.askUser]: { readOnly: true, scriptExposable: false },
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

/** The two file-mutation tools the model is always offered. */
export const EDIT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.edit,
    description:
      "Replace text in an existing file. For one replacement, pass oldString/newString. " +
      "For several replacements in the SAME file, pass edits: [{oldString,newString}, ...]; " +
      "the batch is atomic and costs one tool call. Every oldString must identify one unique " +
      "site, so include a few surrounding lines when the literal itself repeats.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative file path." },
        oldString: {
          type: "string",
          description: "Exact unique text for a single replacement.",
        },
        newString: {
          type: "string",
          description: "Replacement text for a single replacement.",
        },
        edits: {
          type: "array",
          description:
            "Atomic multi-site replacements in this file. Use unique surrounding context for repeated literals.",
          items: {
            type: "object",
            properties: {
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["oldString", "newString"],
          },
        },
      },
      required: ["file"],
      anyOf: [
        { required: ["oldString", "newString"] },
        { required: ["edits"] },
      ],
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

/**
 * The pull_conventions tool, built per-offer so its `topic` enum carries the
 * injected convention provider's REAL topics — the same enum-at-offer pattern
 * `buildSpawnAgentTool` uses for `subagent_type`. Core stays stack-agnostic: the
 * topic list comes from the adapter's provider (`IConventionProvider.topics()`)
 * at offer time, never a hardcoded literal here. With an enum the model gets
 * structured guidance and can't waste a turn on an invalid topic; the handler's
 * miss→listing recovery still guards a hallucinated topic. With no topics (an
 * empty provider) the enum is omitted so the tool stays usable as a free-form
 * lookup.
 */
export function buildPullConventionsTool(topics: readonly string[]): {
  readonly type: "function";
  readonly function: {
    readonly name: typeof TOOL_NAME.pullConventions;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: {
        readonly topic: {
          readonly type: "string";
          readonly description: string;
          readonly enum?: readonly string[];
        };
      };
      readonly required: readonly ["topic"];
    };
  };
} {
  const topic =
    topics.length > 0
      ? {
          type: "string" as const,
          description:
            "which convention guide to fetch — one of the enumerated topics.",
          enum: topics,
        }
      : {
          type: "string" as const,
          description:
            "which convention guide to fetch — one of the topics listed in the front-loaded guides in your system prompt. An unknown topic returns the list of valid ones.",
        };

  return {
    type: "function",
    function: {
      name: TOOL_NAME.pullConventions,
      description:
        "Re-fetch the stack's HOW-TO guide for a convention topic on demand. The guides are ALREADY front-loaded in your system prompt — use this to re-read one you need again, or for a rule you're still unsure how to satisfy. Returns the exact pattern the gate enforces.",
      parameters: {
        type: "object",
        properties: { topic },
        required: ["topic"],
      },
    },
  };
}

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

export const CHECK_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.check,
    description:
      "Run the fast acceptance gate NOW and get back ALL current errors as structured JSON ({file, line, rule, message}). Call it before you stop — see and fix your whole error set in ONE pass instead of discovering errors one at a time on later turns. Takes no arguments. Returns {passed:true} when clean. If the result has an `autoFixed` list, the gate reformatted those files on disk this run — RE-READ them before your next edit (their content and line anchors changed); do NOT redo that formatting by hand.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
} as const;

export const ASK_USER_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME.askUser,
    description:
      "Ask the human ONE specific, bounded question when you are genuinely blocked on a DECISION only they can make — an ambiguous requirement, a product choice, a missing credential — and cannot proceed sensibly on your own. This is a last resort, not a substitute for investigating the code: try `read`/`search` first. Do NOT use it to narrate progress or ask permission for routine work. Ask one concrete question with the options you're weighing; the human answers and you continue. If no human is available (an unattended run), you'll be told to proceed with your best judgment.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The single, specific question for the human — include the concrete options or the decision you're stuck on.",
        },
      },
      required: ["question"],
    },
  },
} as const;

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
