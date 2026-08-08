import { join, isAbsolute } from "node:path";
import type { ITaskRecipe } from "../config/recipes";
import { isProfileId, PROFILE_IDS, type ProfileId } from "../config/profiles";

/**
 * CLI argument parsing + recipe overlay — pure, no I/O, no module state. Extracted
 * from cli.ts so the parse/overlay logic is unit-testable in isolation (see
 * tests/cli.test.ts) and the CLI entry stays thin.
 */
export interface ICliArgs {
  /** Print the package version and exit (`--version` / `-V`). */
  version: boolean;
  /** Print CLI usage and exit (`--help` / `-h`) — install.sh advertises this. */
  help: boolean;
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
  /** Run a human-written worklist (`--work`). `task` is an optional list path;
   *  when empty, looks up PLAN.md → TASKS.md → .specs/next.md. */
  work: boolean;
  /** Opt-in rewrite of the human checklist file as items pass (`--tick`). */
  tick: boolean;
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
  /** The `agents` subcommand (`tsforge agents [ids] "task"`): run named agent
   *  specs against a task, or list discovered specs when no ids are given. */
  agents: boolean;
  /** Comma-separated agent spec ids to fan out (subcommand arg or a recipe's
   *  `agents` field); "" = list mode. */
  agentIds: string;
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
  /** Rule profile override — `--profile <id>` or a recipe; "" = use tsforge.config.json /
   *  the default. Persisted so `--continue` keeps the strictness a build was started with. */
  profile: string;
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
  | "work"
  | "tick"
  | "setupYes"
  | "version"
  | "help"
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
  "--work": "work",
  "--tick": "tick",
  "--yes": "setupYes",
  "--version": "version",
  "-V": "version",
  "--help": "help",
  "-h": "help",
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
  "--profile",
  "--recipe",
  "--notify",
]);

/** True for any token the parser recognises as a flag, boolean or value-taking. */
function isKnownFlag(token: string): boolean {
  return (
    Object.hasOwn(BOOL_FLAGS, token) ||
    VALUE_FLAGS.has(token) ||
    // Removed flags — still recognized so old aliases/scripts do not become task text.
    token === "--tui-panes" ||
    token === "--no-tui-panes"
  );
}

/**
 * The first value-taking flag that was given no value — either nothing follows it
 * or the next token is another flag. Null when every value flag has one.
 *
 * A value flag that quietly takes the default is the failure #105 hit with
 * `--profile`: the user asks for something, the run proceeds without it, and
 * nothing says so. That guard covered one flag; this covers all of them.
 *
 * A value may itself contain dashes (`--accept "bun test -- x.ts"`), so the check
 * is "the next token is a flag the parser knows", never "it starts with -".
 */
export function valueFlagError(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined || !VALUE_FLAGS.has(arg)) {
      continue;
    }

    const value = argv[i + 1];

    if (value === undefined) {
      return `${arg} needs a value`;
    }

    if (isKnownFlag(value)) {
      return `${arg} needs a value, but got the flag "${value}"`;
    }

    i += 1;
  }

  return null;
}

/** The `tsforge --help` usage text — kept next to the flag tables it documents
 *  so a new flag is added in one file. Pure so it's directly testable. */
export function cliUsage(): string {
  return [
    "tsforge — strict-TypeScript coding agent (gate-driven)",
    "",
    "USAGE",
    "  tsforge                       interactive session (REPL)",
    '  tsforge "<task>"              one-shot task, driven to a green gate',
    "  tsforge review [--staged]     functional review of the current diff",
    "  tsforge map                   structural workspace map",
    "  tsforge setup [--yes]         infer + write project conventions",
    "  tsforge recipes | run <id>    list / run saved task recipes",
    "  tsforge scaffold …            scaffold a project from the manifest",
    "",
    "COMMON FLAGS",
    "  --dir <path>        workspace to operate in (default: cwd)",
    "  --files <globs>     editable scope, comma-separated",
    "  --accept <cmd>      the gate command that must exit 0",
    "  --continue, -c      resume the most recent session for this dir",
    "  --resume <id>       resume a specific saved session",
    "  --web               scaffold + gate a web app (vite/react ladder)",
    "  --plan              pause after the design phase for plan review",
    "  --log               append the run's event stream to ~/.tsforge/logs/",
    "  --policy-mode <m>   plan|default|acceptEdits|ci|dontAsk|bypassPermissions",
    `  --profile <id>      strictness: ${PROFILE_IDS.join("|")}`,
    "  --notify <cmd>      run a command when an unattended run finishes",
    "  --work [path]       drive a checklist (PLAN.md / TASKS.md / path)",
    "  --tick              rewrite the human checklist as items pass",
    "  --version, -V       print the version and exit",
    "  --help, -h          this help",
    "",
    "In the REPL, /help lists commands; /config is the settings hub.",
    "",
  ].join("\n");
}

/** Parse argv (without the tsforge binary name). Always succeeds — mode is decided in main. */
export function parseArgs(argv: readonly string[]): ICliArgs {
  const positional: string[] = [];
  const out: ICliArgs = {
    version: false,
    help: false,
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
    work: false,
    tick: false,
    notify: "",
    base: "",
    map: false,
    trace: false,
    recipe: "",
    recipes: false,
    agents: false,
    agentIds: "",
    run: false,
    model: "",
    plannerModel: "",
    workModel: "",
    evaluatorModel: "",
    maxTurns: 0,
    thinkingBudget: 0,
    profile: "",
    policyMode: "",
    setup: false,
    setupYes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    // Pane console is the only interactive UI — old opt-in/out flags are no-ops.
    if (arg === "--tui-panes" || arg === "--no-tui-panes") {
      continue;
    }

    const boolKey = BOOL_FLAGS[arg];

    if (boolKey !== undefined) {
      out[boolKey] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];

      // Only consume the next token when it is a real value. Handing a value flag
      // another flag (`--notify --continue`) must not eat it — that silently
      // dropped the second flag and set the first to the flag's own name.
      // `valueFlagError` aborts the run before this matters; the parse stays
      // honest so the surviving flag still reads correctly.
      if (value !== undefined && !isKnownFlag(value)) {
        applyValueFlag(arg, value, out);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }

  out.task = positional.join(" ").trim();
  applyPositionalSubcommand(positional, out);

  out.dir = isAbsolute(out.dir) ? out.dir : join(process.cwd(), out.dir);

  return out;
}

/** `tsforge review` / `map` / … — first positional selects the mode, not the task. */
function applyPositionalSubcommand(
  positional: readonly string[],
  out: ICliArgs
): void {
  const head = positional[0];

  if (head === "review") {
    out.review = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (head === "map") {
    out.map = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (head === "trace") {
    out.trace = true;
    out.task = positional.slice(1).join(" ").trim();
  } else if (head === "recipes") {
    out.recipes = true;
  } else if (head === "agents") {
    // `tsforge agents` lists specs; `tsforge agents explore,verify "task"`
    // fans the named specs out over the task.
    out.agents = true;
    out.agentIds = positional[1] ?? "";
    out.task = positional.slice(2).join(" ").trim();
  } else if (head === "setup") {
    out.setup = true;
  } else if (head === "run") {
    out.run = true;
    out.recipe = positional[1] ?? "";
    out.task = positional.slice(2).join(" ").trim();
  }
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
  } else if (flag === "--profile") {
    out.profile = value;
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

  if (args.profile.length === 0 && recipe.profile !== undefined) {
    args.profile = recipe.profile;
  }

  // A recipe with `agents` IS a fan-out run: pre-fill the ids and select the
  // agents mode (an explicit `tsforge agents <ids>` still wins on ids).
  if (args.agentIds.length === 0 && recipe.agents !== undefined) {
    args.agentIds = recipe.agents.join(",");
    args.agents = true;
  }

  applyRecipeFlags(args, recipe);
}

/** Resolve a recipe/CLI profile string to a ProfileId, or undefined when unset. */
export function resolveCliProfile(profile: string): ProfileId | undefined {
  const trimmed = profile.trim();

  return trimmed.length > 0 && isProfileId(trimmed) ? trimmed : undefined;
}

/** Error message for an invalid `--profile`, or null when the profile is fine. A profile
 *  is "indicated" when a value was set OR the `--profile` flag was present (a trailing
 *  `--profile` with no value must fail loudly, not silently run at the default). Not
 *  indicated (no value, no flag) → null (the project config / default drives it). */
export function profileFlagError(
  profile: string,
  flagPresent: boolean
): string | null {
  if (!flagPresent && profile.length === 0) {
    return null;
  }

  if (isProfileId(profile)) {
    return null;
  }

  return `unknown --profile "${profile}" — valid: ${PROFILE_IDS.join(", ")}`;
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
