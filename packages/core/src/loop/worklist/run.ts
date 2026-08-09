import { readFile, writeFile } from "node:fs/promises";
import { hasState, loadState, runGreenfield, saveState } from "../greenfield";
import type {
  IFeature,
  IGreenfieldDeps,
  IGreenfieldOptions,
  IGreenfieldResult,
  IGreenfieldState,
} from "../greenfield";
import { itemsToFeatures, parseWorklist, resolveWorklistPath } from "./parse";
import type { IWorklistItem } from "./worklist.types";

/** Persistence subdirectory under `.tsforge/` for worklist runs. */
export const WORKLIST_STATE = "worklist";

export interface IPrepareWorklistOptions {
  /** Goal line stored in state / progress.md. */
  goal?: string;
  /** Explicit worklist file (relative to cwd or absolute). */
  path?: string;
  /** Pre-parsed items — skips file lookup when provided. */
  items?: readonly IWorklistItem[];
}

/**
 * Resume `.tsforge/worklist/` when present; otherwise parse a list file (or
 * supplied items) into a fresh checklist and persist it.
 */
export async function prepareWorklistState(
  cwd: string,
  opts: IPrepareWorklistOptions = {}
): Promise<IGreenfieldState | null> {
  if (await hasState(cwd, WORKLIST_STATE)) {
    const existing = await loadState(cwd, WORKLIST_STATE);

    if (existing !== null && existing.features.length > 0) {
      return existing;
    }
  }

  let items: readonly IWorklistItem[];

  if (opts.items !== undefined) {
    items = opts.items;
  } else {
    const path = await resolveWorklistPath(cwd, opts.path);

    if (path === null) {
      return null;
    }

    const md = await readFile(path, "utf8");

    items = parseWorklist(md);
  }

  if (items.length === 0) {
    return null;
  }

  const state: IGreenfieldState = {
    goal: opts.goal ?? "worklist",
    features: itemsToFeatures(items),
  };

  await saveState(cwd, state, WORKLIST_STATE);

  return state;
}

/**
 * Drive a worklist through `runGreenfield`, persisting under `.tsforge/worklist/`.
 */
export async function runWorklist(
  cwd: string,
  state: IGreenfieldState,
  deps: IGreenfieldDeps,
  opts: IGreenfieldOptions = {}
): Promise<IGreenfieldResult> {
  return runGreenfield(cwd, state, deps, {
    ...opts,
    stateName: WORKLIST_STATE,
  });
}

/**
 * Opt-in rewrite of a human checklist file: flip `- [ ] <exact text>` to
 * `- [x]` for features that already pass. Leaves numbered lists and unmatched
 * lines untouched.
 */
export async function tickWorklistFile(
  path: string,
  features: readonly IFeature[]
): Promise<void> {
  const passed = new Set(
    features.filter((f) => f.passes).map((f) => f.desc.trim())
  );

  if (passed.size === 0) {
    return;
  }

  const md = await readFile(path, "utf8");
  const lines = md.split("\n");
  const next: string[] = [];
  let changed = false;

  for (const line of lines) {
    const match = /^(\s*[-*]\s+)\[ \](\s+)(.+)$/u.exec(line);

    if (match === null) {
      next.push(line);
      continue;
    }

    const prefix = match[1] ?? "";
    const gap = match[2] ?? " ";
    const body = match[3] ?? "";
    const text = body.trim();

    if (!passed.has(text)) {
      next.push(line);
      continue;
    }

    changed = true;
    next.push(`${prefix}[x]${gap}${body}`);
  }

  if (changed) {
    await writeFile(path, next.join("\n"));
  }
}
