import { join, isAbsolute } from "node:path";
import type { ITaskRecipe } from "../config/recipes";

/**
 * CLI argument parsing + recipe overlay — pure, no I/O, no module state. Extracted
 * from cli.ts so the parse/overlay logic is unit-testable in isolation (see
 * tests/cli.test.ts) and the CLI entry stays thin.
 */
export interface ICliArgs {
  /** Empty ⇒ interactive REPL; non-empty ⇒ one-shot task. */
  task: string;
  dir: string;
  files: string[];
  accept: string;
  /** Resume the most recent saved session for this dir (`--continue` / `-c`). */
  continue: boolean;
  /** Resume a specific session by id (`--resume <id>`). */
  resumeId: string;
  /** Skip auto-detecting a gate from the project (`--no-gate`). */
  noGate: boolean;
  /** An HTML file to render-check in headless chromium as part of the gate (`--browser`). */
  browser: string;
  /** Scaffold + gate a web app: skeleton + tsc/eslint/build/browser ladder (`--web`). */
  web: boolean;
  /** Append the full event stream (reasoning, tool writes, gate verdicts) as JSONL
   *  to an auto-named file under ~/.tsforge/logs/ for later evaluation (`--log`). */
  log: boolean;
  /** Plan mode: a from-scratch build pauses after the design phase to show its
   *  plan for review/edit before implementing (`--plan`; also toggled by /plan). */
  plan: boolean;
  /** Keep the auto-gate at the strict TS floor only — do NOT append the
   *  project's discovered tests (`--strict-floor-only`). By default the auto-gate
   *  also runs the project's tests, so "green" means floor + tests pass. */
  strictFloorOnly: boolean;
  /** Review the change you're on (functional review of the diff) (`tsforge review`). */
  review: boolean;
  /** Review only staged changes (`--staged`). */
  staged: boolean;
  /** Run the gate first and tell the reviewer to skip what it already covers
   *  (`tsforge review --with-gate`). */
  withGate: boolean;
  /** After a one-shot run goes green, run the adversarial review and feed verified
   *  findings into ONE repair cycle, reverting it if it breaks the gate
   *  (`--with-review`). */
  withReview: boolean;
  /** Seed a brownfield run with a deterministic caller blast-radius scout
   *  (`--scout`). */
  scout: boolean;
  /** Run the greenfield feature-checklist outer loop (`--greenfield`, or a recipe
   *  with `mode: "greenfield"`). `task` carries the one-line build goal. */
  greenfield: boolean;
  /** Shell command to run on completion of an unattended run (`--notify <cmd>`),
   *  with the outcome in $TSFORGE_STATUS. "" = no notification. */
  notify: string;
  /** Explicit base ref to diff against for review (`--base <ref>`). */
  base: string;
  /** Build a structural workspace map (`tsforge map`). */
  map: boolean;
  /** Summarize a `--log` run (`tsforge trace [logfile]`); `task` carries the path. */
  trace: boolean;
  /** Recipe id to apply (`tsforge run <id>` or `--recipe <id>`); "" = none. */
  recipe: string;
  /** List discovered recipes (`tsforge recipes`). */
  recipes: boolean;
  /** The `run` subcommand was used (`tsforge run <id>`) — tracked so a missing id
   *  is an explicit error, not a silent fall-through to the interactive REPL. */
  run: boolean;
  /** Model name override (from a recipe); "" = the active model. */
  model: string;
  /** Greenfield role models (from a recipe); "" = fall back to `model`/active. */
  plannerModel: string;
  workModel: string;
  evaluatorModel: string;
  /** Hard turn cap (from a recipe); 0 = the loop default. */
  maxTurns: number;
  /** Reasoning-token cap (from a recipe); 0 = the env/default. */
  thinkingBudget: number;
  /** Base policy mode (`--policy-mode <plan|default|acceptEdits|ci|dontAsk|
   *  bypassPermissions>`); overrides the config file's policy.mode. */
  policyMode: string;
  /** Run the onboarding wizard that infers + writes project conventions
   *  (`tsforge setup`). */
  setup: boolean;
  /** Write the scan's recommended conventions non-interactively (`tsforge setup
   *  --yes`). */
  setupYes: boolean;
}

const BOOL_FLAGS: Record<
  string,
  | "continue"
  | "noGate"
  | "web"
  | "log"
  | "plan"
  | "strictFloorOnly"
  | "staged"
  | "withGate"
  | "withReview"
  | "scout"
  | "greenfield"
  | "setupYes"
> = {
  "--continue": "continue",
  "-c": "continue",
  "--no-gate": "noGate",
  "--web": "web",
  "--log": "log",
  "--plan": "plan",
  "--strict-floor-only": "strictFloorOnly",
  "--staged": "staged",
  "--with-gate": "withGate",
  "--with-review": "withReview",
  "--scout": "scout",
  "--greenfield": "greenfield",
  "--yes": "setupYes",
};

const VALUE_FLAGS = new Set([
  "--dir",
  "--files",
  "--accept",
  "--gate",
  "--browser",
  "--resume",
  "--base",
  "--policy-mode",
  "--recipe",
  "--notify",
]);

/** Parse argv (without the tsforge binary name). Always succeeds — mode is decided in main. */
export function parseArgs(argv: readonly string[]): ICliArgs {
  const positional: string[] = [];
  const out: ICliArgs = {
    task: "",
    dir: ".",
    files: [],
    accept: "",
    continue: false,
    resumeId: "",
    noGate: false,
    browser: "",
    web: false,
    log: false,
    plan: false,
    strictFloorOnly: false,
    review: false,
    staged: false,
    withGate: false,
    withReview: false,
    scout: false,
    greenfield: false,
    notify: "",
    base: "",
    map: false,
    trace: false,
    recipe: "",
    recipes: false,
    run: false,
    model: "",
    plannerModel: "",
    workModel: "",
    evaluatorModel: "",
    maxTurns: 0,
    thinkingBudget: 0,
    policyMode: "",
    setup: false,
    setupYes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    const boolKey = BOOL_FLAGS[arg];

    if (boolKey !== undefined) {
      out[boolKey] = true;
    } else if (VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined) {
      applyValueFlag(arg, argv[i + 1] ?? "", out);
      i += 1;
    } else if (!VALUE_FLAGS.has(arg)) {
      positional.push(arg);
    }
  }

  out.task = positional.join(" ").trim();

  // `tsforge review` / `tsforge map` are subcommands, not tasks: the first
  // positional selects them.
  if (positional[0] === "review") {
    out.review = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (positional[0] === "map") {
    out.map = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (positional[0] === "trace") {
    out.trace = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (positional[0] === "recipes") {
    out.recipes = true;
  } else if (positional[0] === "setup") {
    out.setup = true;
  } else if (positional[0] === "run") {
    out.run = true;
    out.recipe = positional[1] ?? "";
    out.task = positional.slice(2).join(" ").trim();
  }

  out.dir = isAbsolute(out.dir) ? out.dir : join(process.cwd(), out.dir);

  return out;
}

/** Assign one `--flag value` into the args (mutates `out`). */
function applyValueFlag(flag: string, value: string, out: ICliArgs): void {
  if (flag === "--dir") {
    out.dir = value;
  } else if (flag === "--files") {
    out.files = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (flag === "--browser") {
    out.browser = value;
  } else if (flag === "--resume") {
    out.resumeId = value;
  } else if (flag === "--base") {
    out.base = value;
  } else if (flag === "--policy-mode") {
    out.policyMode = value;
  } else if (flag === "--recipe") {
    out.recipe = value;
  } else if (flag === "--notify") {
    out.notify = value;
  } else {
    out.accept = value; // --accept / --gate
  }
}

/** Overlay a recipe's fields onto the parsed args. An explicit CLI value ALWAYS
 *  wins (a recipe only fills a field still at its default), so `tsforge run x
 *  --files src/**` overrides the recipe's scope. Booleans can only be turned ON
 *  by a recipe — a CLI flag can't switch a recipe's `true` back off. */
export function applyRecipe(args: ICliArgs, recipe: ITaskRecipe): void {
  if (args.task.length === 0 && recipe.task !== undefined) {
    args.task = recipe.task;
  }

  if (args.files.length === 0 && recipe.files !== undefined) {
    args.files = [...recipe.files];
  }

  if (args.accept.length === 0 && recipe.gate !== undefined) {
    args.accept = recipe.gate;
  }

  if (args.model.length === 0 && recipe.model !== undefined) {
    args.model = recipe.model;
  }

  applyRecipeModels(args, recipe);

  if (args.base.length === 0 && recipe.base !== undefined) {
    args.base = recipe.base;
  }

  if (args.policyMode.length === 0 && recipe.policyMode !== undefined) {
    args.policyMode = recipe.policyMode;
  }

  if (args.maxTurns === 0 && recipe.maxTurns !== undefined) {
    args.maxTurns = recipe.maxTurns;
  }

  if (args.thinkingBudget === 0 && recipe.thinkingBudget !== undefined) {
    args.thinkingBudget = recipe.thinkingBudget;
  }

  applyRecipeFlags(args, recipe);
}

/** Recipe greenfield role models (split out to keep applyRecipe's complexity in
 *  check). A recipe only fills a role still at its default. */
function applyRecipeModels(args: ICliArgs, recipe: ITaskRecipe): void {
  if (args.plannerModel.length === 0 && recipe.plannerModel !== undefined) {
    args.plannerModel = recipe.plannerModel;
  }

  if (args.workModel.length === 0 && recipe.workModel !== undefined) {
    args.workModel = recipe.workModel;
  }

  if (args.evaluatorModel.length === 0 && recipe.evaluatorModel !== undefined) {
    args.evaluatorModel = recipe.evaluatorModel;
  }
}

/** Recipe booleans (split out to keep applyRecipe's complexity in check). */
function applyRecipeFlags(args: ICliArgs, recipe: ITaskRecipe): void {
  args.staged = args.staged || recipe.staged === true;
  args.strictFloorOnly =
    args.strictFloorOnly || recipe.strictFloorOnly === true;
  args.web = args.web || recipe.web === true;
  args.plan = args.plan || recipe.plan === true;
  args.log = args.log || recipe.log === true;
  args.withGate = args.withGate || recipe.withGate === true;
  args.withReview = args.withReview || recipe.withReview === true;
  args.scout = args.scout || recipe.scout === true;
  args.greenfield = args.greenfield || recipe.mode === "greenfield";
}

// Default editable scope: the whole workspace — like any agentic CLI, the agent
// may edit any file. `--files` only NARROWS this (a safety/eval tripwire); it's
// never required. `**/*` matches top-level and nested paths alike.
export const WHOLE_REPO = ["**/*"];

/** Resolve the editable scope: an explicit `--files` narrowing, else the whole repo. */
export function scopeOf(args: ICliArgs): string[] {
  return args.files.length > 0 ? args.files : WHOLE_REPO;
}

/** One-shot mode = a task PLUS a gate to drive to green; else interactive. */
export function isOneShot(args: ICliArgs): boolean {
  return args.task.length > 0 && args.accept.length > 0;
}
