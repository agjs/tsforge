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
  // One or more alphanumeric segments separated by single hyphens: true
  // kebab-case, so `a`/`a-b` pass but `a-`/`-a`/`a--b` do not.
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id);
}

/** Validate and extract the handoff from a parsed JSON value. Returns null if invalid. */
function parseHandoff(handoff: unknown): IFeature["handoff"] | null {
  if (
    !isRecord(handoff) ||
    typeof handoff.block !== "string" ||
    !Array.isArray(handoff.rungHistory) ||
    !Array.isArray(handoff.errors) ||
    typeof handoff.ask !== "string" ||
    handoff.resumable !== true ||
    !isRecord(handoff.resume)
  ) {
    return null;
  }

  // Validate rungHistory
  const rungHistoryValid = handoff.rungHistory.every(
    (r: unknown) => r === "R1" || r === "R2" || r === "R3" || r === "R4"
  );

  if (!rungHistoryValid) {
    return null;
  }

  // Validate errors
  const errorsValid = handoff.errors.every(
    (e: unknown) => typeof e === "string"
  );

  if (!errorsValid) {
    return null;
  }

  const resume = handoff.resume;
  let validResume:
    | { triedLevers: ("R1" | "R2" | "R3" | "R4")[] }
    | { checkpointRef: string }
    | null = null;

  if (Array.isArray(resume.triedLevers)) {
    const triedLeversValid = resume.triedLevers.every(
      (t: unknown) => t === "R1" || t === "R2" || t === "R3" || t === "R4"
    );

    if (triedLeversValid) {
      const typedLevers: ("R1" | "R2" | "R3" | "R4")[] =
        resume.triedLevers.filter(
          (t): t is "R1" | "R2" | "R3" | "R4" =>
            t === "R1" || t === "R2" || t === "R3" || t === "R4"
        );

      validResume = { triedLevers: typedLevers };
    }
  } else if (typeof resume.checkpointRef === "string") {
    validResume = { checkpointRef: resume.checkpointRef };
  }

  if (validResume === null) {
    return null;
  }

  const typedRungs: ("R1" | "R2" | "R3" | "R4")[] = handoff.rungHistory.filter(
    (r): r is "R1" | "R2" | "R3" | "R4" =>
      r === "R1" || r === "R2" || r === "R3" || r === "R4"
  );

  const typedErrors: string[] = handoff.errors.filter(
    (e): e is string => typeof e === "string"
  );

  return {
    block: handoff.block,
    rungHistory: typedRungs,
    errors: typedErrors,
    ask: handoff.ask,
    resumable: true,
    resume: validResume,
  };
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

  const { id, desc, passes, attempts, steps, lastError, parked, handoff } =
    value;

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

  if (parked === true) {
    feature.parked = true;
  }

  const parsedHandoff = parseHandoff(handoff);

  if (parsedHandoff !== null) {
    feature.handoff = parsedHandoff;
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

/** Whether a greenfield checklist EXISTS on disk — regardless of whether it parses.
 *  This is the true "is this a RESUME?" signal. `loadState` returns null for BOTH a
 *  missing AND a present-but-corrupt file, so it must NOT be used to detect a fresh
 *  start: a corrupt features.json on a tree that was already built into would look
 *  "fresh" and let a caller re-capture a CONTAMINATED baseline (a false-green). Err
 *  toward resume — presence ⇒ resume, only true absence ⇒ fresh. */
export async function hasState(cwd: string): Promise<boolean> {
  return Bun.file(featuresPath(cwd)).exists();
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
    let box: string;

    if (f.passes) {
      box = "[x]";
    } else if (f.parked === true) {
      box = "[~]";
    } else {
      box = "[ ]";
    }

    const attempts = f.attempts > 0 ? ` (attempts: ${f.attempts})` : "";
    const parkedNote = f.parked === true ? " (parked)" : "";

    return `- ${box} ${f.id} — ${f.desc}${attempts}${parkedNote}`;
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
