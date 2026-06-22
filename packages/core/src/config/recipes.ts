import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { isPolicyMode, type PolicyMode } from "../policy";

/**
 * A declarative task recipe — tsforge's adaptation of Codebuff's `AgentDefinition`
 * to a deterministic config object. A recipe NAMES a run setup by composing knobs
 * tsforge already has; it never executes code (no `handleSteps`, no spawned
 * subagents), so a repo's recipes stay reviewable data, not a program.
 *
 * Discovered from `.tsforge/recipes/*.json` (project) and `~/.tsforge/recipes/*.json`
 * (global); a project recipe overrides a global one with the same id.
 */
export interface ITaskRecipe {
  /** Stable id (kebab-case); the name you invoke with `tsforge run <id>`. */
  readonly id: string;
  /** One-line summary shown by `tsforge recipes`. */
  readonly description?: string;
  /** Default task/prompt for the run (a CLI positional still overrides it). */
  readonly task?: string;
  /** Editable scope globs (→ the run's `--files`). */
  readonly files?: readonly string[];
  /** The gate command that confirms "done" (→ `--accept`). */
  readonly gate?: string;
  /** A configured model name from `~/.tsforge/models.json` (→ the run's model). */
  readonly model?: string;
  /** Greenfield role models (names from `~/.tsforge/models.json`). Each defaults
   *  to `model`/the active model when unset, so single-endpoint setups still work
   *  (same model, different role prompts). The evaluator stays trace-blind
   *  regardless of which model backs it. */
  readonly plannerModel?: string;
  readonly workModel?: string;
  readonly evaluatorModel?: string;
  /** Hard cap on model turns (→ run option `maxTurns`). */
  readonly maxTurns?: number;
  /** Reasoning-token cap per call (→ run option `thinkingTokenBudget`). */
  readonly thinkingBudget?: number;
  /** Base policy enforcement mode (→ `--policy-mode`). */
  readonly policyMode?: PolicyMode;
  /** Diff base ref for a review-style run (→ `--base`). */
  readonly base?: string;
  /** Review only staged changes (→ `--staged`). */
  readonly staged?: boolean;
  /** Keep the gate at the strict TS floor only (→ `--strict-floor-only`). */
  readonly strictFloorOnly?: boolean;
  /** Scaffold + gate a web app (→ `--web`). */
  readonly web?: boolean;
  /** Start in plan mode (→ `--plan`). */
  readonly plan?: boolean;
  /** Record the run ledger (→ `--log`). */
  readonly log?: boolean;
  /** Run a gate-aware functional review after green (→ `review --with-gate`). */
  readonly withGate?: boolean;
  /** After green, run the adversarial review and feed verified findings into ONE
   *  repair cycle (revert if it breaks the gate) (→ `--with-review`). */
  readonly withReview?: boolean;
  /** Seed a deterministic pre-edit caller blast-radius scout (→ `--scout`). */
  readonly scout?: boolean;
  /** Run mode. `"greenfield"` selects the feature-checklist outer loop
   *  (`runGreenfield`) instead of the default single-task loop. Omitted ⇒ the
   *  normal brownfield/one-shot run. */
  readonly mode?: "greenfield";
}

function optString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optPositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  return strings.length > 0 ? strings : undefined;
}

/** Assign the optional scalar fields onto a recipe under construction. */
function assignScalars(recipe: Mutable, raw: Record<string, unknown>): void {
  recipe.description = optString(raw.description);
  recipe.task = optString(raw.task);
  recipe.gate = optString(raw.gate);
  recipe.model = optString(raw.model);
  recipe.plannerModel = optString(raw.plannerModel);
  recipe.workModel = optString(raw.workModel);
  recipe.evaluatorModel = optString(raw.evaluatorModel);
  recipe.base = optString(raw.base);
  recipe.files = stringArray(raw.files);
  recipe.maxTurns = optPositive(raw.maxTurns);
  recipe.thinkingBudget = optPositive(raw.thinkingBudget);

  if (isPolicyMode(raw.policyMode)) {
    recipe.policyMode = raw.policyMode;
  }

  if (raw.mode === "greenfield") {
    recipe.mode = raw.mode;
  }
}

/** Assign the optional boolean flags onto a recipe under construction. */
function assignFlags(recipe: Mutable, raw: Record<string, unknown>): void {
  recipe.staged = optBool(raw.staged);
  recipe.strictFloorOnly = optBool(raw.strictFloorOnly);
  recipe.web = optBool(raw.web);
  recipe.plan = optBool(raw.plan);
  recipe.log = optBool(raw.log);
  recipe.withGate = optBool(raw.withGate);
  recipe.withReview = optBool(raw.withReview);
  recipe.scout = optBool(raw.scout);
}

type Mutable = { -readonly [K in keyof ITaskRecipe]: ITaskRecipe[K] };

/** Every field a v1 recipe applies. A key outside this set is reported (not
 *  silently dropped) so a typo or not-yet-supported field (e.g. `profile`,
 *  `tools`) is visible rather than mysteriously ignored. */
const KNOWN_KEYS = new Set<string>([
  "id",
  "description",
  "task",
  "files",
  "gate",
  "model",
  "plannerModel",
  "workModel",
  "evaluatorModel",
  "maxTurns",
  "thinkingBudget",
  "policyMode",
  "base",
  "staged",
  "strictFloorOnly",
  "web",
  "plan",
  "log",
  "withGate",
  "withReview",
  "scout",
  "mode",
]);

/** Keys present in the raw recipe that this version doesn't recognize. */
export function unrecognizedKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.keys(value).filter((key) => !KNOWN_KEYS.has(key));
}

/**
 * Validate one parsed JSON value into an ITaskRecipe, or null when it isn't one.
 * Every field is type-checked (no `as`); unknown fields and wrong-typed fields are
 * dropped, so a malformed recipe degrades to "ignored", never a crash.
 */
export function parseRecipe(value: unknown): ITaskRecipe | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = optString(value.id);

  if (id === undefined || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    return null;
  }

  const recipe: Mutable = { id };

  assignScalars(recipe, value);
  assignFlags(recipe, value);

  return recipe;
}

/** The two recipe directories, lowest precedence first (global, then project). */
function recipeDirs(cwd: string): string[] {
  const home = process.env.TSFORGE_HOME ?? homedir();

  return [join(home, ".tsforge", "recipes"), join(cwd, ".tsforge", "recipes")];
}

/** Sorted `*.json` filenames in a directory, or [] if it doesn't exist. */
async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return []; // no such directory — fine
  }
}

/** Parse every `*.json` recipe in one directory; unreadable/invalid files are
 *  reported and skipped (never throws). */
async function loadDir(
  dir: string,
  into: Map<string, ITaskRecipe>,
  report: (message: string) => void
): Promise<void> {
  for (const name of await jsonFilesIn(dir)) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8").catch(() => "");
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      report(`recipe '${name}': invalid JSON — skipped`);
      continue;
    }

    const recipe = parseRecipe(parsed);

    if (recipe === null) {
      report(
        `recipe '${name}': not a valid recipe (needs a kebab-case id) — skipped`
      );
      continue;
    }

    const expectedId = name.slice(0, -".json".length);

    if (recipe.id !== expectedId) {
      report(
        `recipe '${name}': id '${recipe.id}' does not match the filename — invoke it as '${recipe.id}'`
      );
    }

    const unknown = unrecognizedKeys(parsed);

    if (unknown.length > 0) {
      report(
        `recipe '${name}': ignoring unrecognized field(s): ${unknown.join(", ")}`
      );
    }

    into.set(recipe.id, recipe); // later dir (project) wins on id collision
  }
}

/**
 * Discover all recipes for a repo, project overriding global on id collision.
 * Never throws — a broken recipe can't take down a run.
 */
export async function loadRecipes(
  cwd: string,
  report: (message: string) => void = () => undefined
): Promise<ITaskRecipe[]> {
  const byId = new Map<string, ITaskRecipe>();

  for (const dir of recipeDirs(cwd)) {
    await loadDir(dir, byId, report);
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Find one recipe by id among the discovered set. */
export function findRecipe(
  recipes: readonly ITaskRecipe[],
  id: string
): ITaskRecipe | undefined {
  return recipes.find((r) => r.id === id);
}
