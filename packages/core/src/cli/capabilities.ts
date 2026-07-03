import { COMMANDS, takesArg } from "./commands";
import { TOOL_NAME } from "../agent";

export type CapabilityKind = "command" | "wizard" | "passive";

export type CapabilityInvoke =
  | { readonly type: "run"; readonly command: string }
  | { readonly type: "prefill"; readonly command: string }
  | { readonly type: "wizard"; readonly opener: "scaffold" | "recipe" };

export interface ICapability {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly describe: string;
  readonly kind: CapabilityKind;
  readonly detail?: string;
  readonly invoke?: CapabilityInvoke;
}

export interface ICapabilityDeps {
  readonly hasRecipes: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const UNDERSTAND_YOUR_CODE = "Understand your code";
const STEER_THE_SESSION = "Steer the session";
const SESSION_AND_COST = "Session & cost";

// ── Command group mapping ────────────────────────────────────────────────────

const COMMAND_TO_GROUP: Readonly<Record<string, string>> = {
  "/review": UNDERSTAND_YOUR_CODE,
  "/map": UNDERSTAND_YOUR_CODE,
  "/plan": STEER_THE_SESSION,
  "/gate": STEER_THE_SESSION,
  "/files": STEER_THE_SESSION,
  "/model": STEER_THE_SESSION,
  "/config": STEER_THE_SESSION,
  "/setup": STEER_THE_SESSION,
  "/sessions": SESSION_AND_COST,
  "/compact": SESSION_AND_COST,
  "/clear": SESSION_AND_COST,
  "/cost": SESSION_AND_COST,
  "/metrics": SESSION_AND_COST,
  "/trace": SESSION_AND_COST,
  "/memory": SESSION_AND_COST,
};

// ── Tool descriptions ───────────────────────────────────────────────────────

interface IToolMetadata {
  readonly label: string;
  readonly describe: string;
  readonly detail: string;
}

const TOOL_METADATA: Readonly<Record<string, IToolMetadata>> = {
  [TOOL_NAME.search]: {
    label: "Search code",
    describe: "ripgrep the workspace for a pattern",
    detail:
      "Your primary way to find code without knowing file paths. Returns file:line matches using ripgrep across the workspace.",
  },
  [TOOL_NAME.symbolSearch]: {
    label: "Find a symbol",
    describe: "locate where a type/function/const is declared by name",
    detail:
      "Find where a symbol is declared across the project using semantic analysis. Returns kind, name, file:line for precise navigation.",
  },
  [TOOL_NAME.findReferences]: {
    label: "List references",
    describe: "find every reference to a symbol semantically",
    detail:
      "Find all references to a symbol across the project using semantic analysis, not just text matching. Give the declaration file and symbol name.",
  },
  [TOOL_NAME.typeAt]: {
    label: "Get inferred type",
    describe: "show the TypeScript type of a symbol",
    detail:
      "Retrieve the inferred TypeScript type of a symbol so you don't have to guess. Give the file and symbol name.",
  },
  [TOOL_NAME.diagnostics]: {
    label: "Check diagnostics",
    describe: "get TypeScript semantic errors for a file",
    detail:
      "Get the TypeScript semantic diagnostics (type errors) for one file on demand so you can verify correctness.",
  },
  [TOOL_NAME.renameSymbol]: {
    label: "Rename a symbol",
    describe: "semantically rename a symbol across all references",
    detail:
      "Semantically rename a symbol across ALL its references in one step (no manual multi-file edits). Rejected if any reference is out-of-scope.",
  },
  [TOOL_NAME.moveFile]: {
    label: "Move a file",
    describe: "move/rename a file and rewrite every import pointing at it",
    detail:
      "Move or rename a file and rewrite every import that points at it (and its own relative imports) in one step — compiler-accurate.",
  },
  [TOOL_NAME.organizeImports]: {
    label: "Organize imports",
    describe: "sort, dedupe, and drop unused imports in a file",
    detail:
      "Sort, deduplicate, and drop unused imports in an editable file deterministically for cleaner code.",
  },
  [TOOL_NAME.gitContext]: {
    label: "Inspect git state",
    describe: "read-only git introspection to scope your work to what changed",
    detail:
      "Read-only, structured git introspection — diff, changed files, log, blame, show. Scope a review or fix to what actually changed.",
  },
  [TOOL_NAME.packageInfo]: {
    label: "Check package metadata",
    describe: "read npm package info from the registry",
    detail:
      "Read current npm package metadata with no API key: latest dist-tag, versions, deprecation, peer deps, homepage. Use before installing.",
  },
  [TOOL_NAME.packageDocs]: {
    label: "Read package docs",
    describe: "get package documentation version-aware",
    detail:
      "Read package documentation with no paid service: local node_modules README first, then npm registry when needed for version-aware docs.",
  },
  [TOOL_NAME.webFetch]: {
    label: "Fetch a web page",
    describe: "read a known URL and extract its main content",
    detail:
      "Fetch a public web page and get its main content back as readable markdown. Use it to READ a known URL — docs, GitHub issues, RFCs.",
  },
  [TOOL_NAME.webSearch]: {
    label: "Search the web",
    describe: "discover URLs and get ranked results with snippets",
    detail:
      "Search the web and get back ranked public result titles, URLs, and snippets. Use it to DISCOVER current sources before fetching.",
  },
  [TOOL_NAME.webBrowse]: {
    label: "Browse with JS",
    describe: "open a URL in a headless browser for JS-rendered content",
    detail:
      "Open a public URL in a local headless Chromium browser via Playwright. Use it when docs require JavaScript or web_fetch misses content.",
  },
  [TOOL_NAME.script]: {
    label: "Run a TypeScript program",
    describe: "write one program that calls tools via stubs",
    detail:
      "Run ONE TypeScript program that calls tools via stubs (read, edit, create, web_search, etc). Best for repetitive multi-step work like scanning many files.",
  },
};

// ── Builders ─────────────────────────────────────────────────────────────────

function commandCapabilities(): ICapability[] {
  const exempt = new Set(["/help", "/exit"]);
  const capabilities: ICapability[] = [];

  for (const spec of COMMANDS) {
    if (exempt.has(spec.name)) {
      continue;
    }

    const group = COMMAND_TO_GROUP[spec.name] ?? SESSION_AND_COST;
    const invoke: CapabilityInvoke = {
      type: takesArg(spec) ? "prefill" : "run",
      command: spec.name,
    };

    capabilities.push({
      id: spec.name,
      group,
      label: spec.summary,
      describe: spec.summary,
      kind: "command",
      invoke,
    });
  }

  return capabilities;
}

function toolCapabilities(): ICapability[] {
  const exempt = new Set([
    "read",
    "run",
    "edit",
    "create",
    "edit_lines",
    "scaffold_web",
    "scaffold_ui",
    "scaffold_routes",
    "add_dependency",
  ]);
  const capabilities: ICapability[] = [];

  for (const tool of Object.values(TOOL_NAME)) {
    if (exempt.has(tool)) {
      continue;
    }

    const metadata = TOOL_METADATA[tool];

    if (metadata === undefined) {
      continue;
    }

    capabilities.push({
      id: `tool.${tool}`,
      group: "The model's tools (always on)",
      label: metadata.label,
      describe: metadata.describe,
      kind: "passive",
      detail: metadata.detail,
    });
  }

  return capabilities;
}

function wizardCapabilities(deps: ICapabilityDeps): ICapability[] {
  const capabilities: ICapability[] = [
    {
      id: "scaffold",
      group: "Build something new",
      label: "Scaffold a project",
      describe:
        "Stand up a new project — boringstack (full stack), astro (static site), or vite (web).",
      kind: "wizard",
      invoke: { type: "wizard", opener: "scaffold" },
    },
  ];

  if (deps.hasRecipes) {
    capabilities.push({
      id: "recipe",
      group: "Build something new",
      label: "Run a recipe",
      describe: "Run a saved build+gate flow from .tsforge/recipes.",
      kind: "wizard",
      invoke: { type: "wizard", opener: "recipe" },
    });
  }

  return capabilities;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildCapabilities(deps: ICapabilityDeps): ICapability[] {
  return [
    ...commandCapabilities(),
    ...toolCapabilities(),
    ...wizardCapabilities(deps),
  ];
}

export function capabilityCommandNames(caps: readonly ICapability[]): string[] {
  const names: string[] = [];

  for (const cap of caps) {
    if (cap.invoke?.type === "run" || cap.invoke?.type === "prefill") {
      names.push(cap.invoke.command);
    }
  }

  return names;
}
