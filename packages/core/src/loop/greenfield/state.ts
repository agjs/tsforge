import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../lib/guards";
import type { IStep } from "../../browser";
import type { IFeature, IGreenfieldState } from "./greenfield.types";

/** The greenfield state directory under the project's `.tsforge/`. */
export function greenfieldDir(cwd: string): string {
  return join(cwd, ".tsforge", "greenfield");
}

/**
 * A safe feature id: kebab-case, no slashes or dots. Feature ids come from the
 * model (the planner) and are later used to build file paths
 * (`contracts/<id>.md`), so an id like `../../README` would escape the state dir.
 * Validate at parse/load time so a malicious/hallucinated id is dropped, never
 * trusted as a path component.
 */
export function isFeatureId(id: string): boolean {
  // Alphanumeric at BOTH ends (or a single char) with internal hyphens only:
  // true kebab-case, so `a`/`a-b` pass but `a-`/`-a`/`a--`-with-trailing don't.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(id);
}

function featuresPath(cwd: string): string {
  return join(greenfieldDir(cwd), "features.json");
}

function specPath(cwd: string): string {
  return join(greenfieldDir(cwd), "spec.md");
}

function progressPath(cwd: string): string {
  return join(greenfieldDir(cwd), "progress.md");
}

/** Coerce one parsed JSON value into an IFeature, dropping it (→ null) when it
 *  isn't shaped like one. No `as` — every field is checked. `steps` rides through
 *  opaquely (it's only ever produced by us and consumed by the browser oracle). */
function toFeature(value: unknown): IFeature | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, desc, passes, attempts, steps, lastError } = value;

  if (typeof id !== "string" || typeof desc !== "string" || !isFeatureId(id)) {
    return null;
  }

  const feature: IFeature = {
    id,
    desc,
    passes: passes === true,
    attempts: typeof attempts === "number" && attempts >= 0 ? attempts : 0,
  };

  if (Array.isArray(steps)) {
    feature.steps = steps.filter((s): s is IStep => isRecord(s));
  }

  if (typeof lastError === "string") {
    feature.lastError = lastError;
  }

  return feature;
}

/** Read the persisted greenfield state, or null when none exists yet / it's
 *  unreadable (a corrupt file degrades to "start fresh", never a crash). */
export async function loadState(cwd: string): Promise<IGreenfieldState | null> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(featuresPath(cwd), "utf8"));
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.goal !== "string") {
    return null;
  }

  const features = Array.isArray(parsed.features)
    ? parsed.features.map(toFeature).filter((f): f is IFeature => f !== null)
    : [];

  return { goal: parsed.goal, features };
}

/** Persist the feature checklist as pretty JSON (diff-friendly, model-resistant). */
export async function saveState(
  cwd: string,
  state: IGreenfieldState
): Promise<void> {
  await mkdir(greenfieldDir(cwd), { recursive: true });
  await writeFile(featuresPath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

/** Write the human-readable spec (the planner's high-level sprints). */
export async function writeSpec(cwd: string, spec: string): Promise<void> {
  await mkdir(greenfieldDir(cwd), { recursive: true });
  await writeFile(specPath(cwd), spec.endsWith("\n") ? spec : `${spec}\n`);
}

/** Render the checklist as a human-readable progress report. Pure (testable). */
export function renderProgress(state: IGreenfieldState): string {
  const done = state.features.filter((f) => f.passes).length;
  const lines = state.features.map((f) => {
    const box = f.passes ? "[x]" : "[ ]";
    const attempts = f.attempts > 0 ? ` (attempts: ${f.attempts})` : "";

    return `- ${box} ${f.id} — ${f.desc}${attempts}`;
  });

  return [
    `# ${state.goal}`,
    "",
    `Progress: ${done}/${state.features.length} features verified`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/** Write progress.md from the current state. */
export async function writeProgress(
  cwd: string,
  state: IGreenfieldState
): Promise<void> {
  await mkdir(greenfieldDir(cwd), { recursive: true });
  await writeFile(progressPath(cwd), renderProgress(state));
}
