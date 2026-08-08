import { access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { isFeatureId } from "../greenfield/state";
import type { IFeature } from "../greenfield/greenfield.types";
import type { IParseWorklistOptions, IWorklistItem } from "./worklist.types";

const DEFAULT_LOOKUP = ["PLAN.md", "TASKS.md", ".specs/next.md"] as const;

const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/;
const NUMBERED_RE = /^(\d+)\.\s+(.+)$/;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Turn item prose into a kebab-case id that satisfies `isFeatureId`.
 * Non-alphanumerics collapse to hyphens; empty residue becomes `"item"`.
 */
export function slugifyItem(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");

  if (slug.length === 0 || !isFeatureId(slug)) {
    return "item";
  }

  return slug;
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);

    return base;
  }

  let n = 2;

  for (;;) {
    const candidate = `${base}-${n}`;

    if (!used.has(candidate) && isFeatureId(candidate)) {
      used.add(candidate);

      return candidate;
    }

    n += 1;
  }
}

interface IWorklistDraft {
  text: string;
  done: boolean;
  accept?: string;
  files?: string[];
  context?: string[];
  fix?: string;
}

function applyProperty(draft: IWorklistDraft, line: string): boolean {
  const acceptMatch = /^\s+accept:\s*(.+)$/u.exec(line);
  const acceptValue = acceptMatch?.[1];

  if (acceptValue !== undefined) {
    draft.accept = acceptValue.trim();

    return true;
  }

  const filesMatch = /^\s+files:\s*(.+)$/u.exec(line);
  const filesValue = filesMatch?.[1];

  if (filesValue !== undefined) {
    draft.files = splitList(filesValue);

    return true;
  }

  const contextMatch = /^\s+context:\s*(.+)$/u.exec(line);
  const contextValue = contextMatch?.[1];

  if (contextValue !== undefined) {
    draft.context = splitList(contextValue);

    return true;
  }

  const fixMatch = /^\s+fix:\s*(.+)$/u.exec(line);
  const fixValue = fixMatch?.[1];

  if (fixValue !== undefined) {
    draft.fix = fixValue.trim();

    return true;
  }

  return false;
}

function pushCurrent(
  drafts: IWorklistDraft[],
  current: IWorklistDraft | null
): void {
  if (current !== null) {
    drafts.push(current);
  }
}

/** Scan markdown into raw drafts (one pass; properties attach to the current item). */
function collectDrafts(md: string): IWorklistDraft[] {
  const drafts: IWorklistDraft[] = [];
  let current: IWorklistDraft | null = null;

  for (const line of md.split("\n")) {
    const checkbox = CHECKBOX_RE.exec(line);

    if (checkbox !== null) {
      pushCurrent(drafts, current);
      const mark = checkbox[2] ?? " ";

      current = {
        text: (checkbox[3] ?? "").trim(),
        done: mark === "x" || mark === "X",
      };
      continue;
    }

    const numbered = NUMBERED_RE.exec(line);

    if (numbered !== null) {
      pushCurrent(drafts, current);
      current = {
        text: (numbered[2] ?? "").trim(),
        done: false,
      };
      continue;
    }

    if (current !== null) {
      applyProperty(current, line);
    }
  }

  pushCurrent(drafts, current);

  return drafts;
}

function draftToItem(
  draft: IWorklistDraft,
  used: Set<string>
): IWorklistItem | null {
  if (draft.text.length === 0) {
    return null;
  }

  const item: IWorklistItem = {
    id: uniqueId(slugifyItem(draft.text), used),
    text: draft.text,
    done: draft.done,
  };

  if (draft.accept !== undefined) {
    item.accept = draft.accept;
  }

  if (draft.files !== undefined) {
    item.files = draft.files;
  }

  if (draft.context !== undefined) {
    item.context = draft.context;
  }

  if (draft.fix !== undefined) {
    item.fix = draft.fix;
  }

  return item;
}

/**
 * Parse a human-written worklist: markdown checkboxes and/or numbered items
 * with optional indented `accept` / `files` / `context` / `fix` properties.
 * Checked boxes are dropped unless `includeDone` is set.
 */
export function parseWorklist(
  md: string,
  opts: IParseWorklistOptions = {}
): IWorklistItem[] {
  const includeDone = opts.includeDone === true;
  const used = new Set<string>();
  const items: IWorklistItem[] = [];

  for (const draft of collectDrafts(md)) {
    if (draft.done && !includeDone) {
      continue;
    }

    const item = draftToItem(draft, used);

    if (item !== null) {
      items.push(item);
    }
  }

  return items;
}

/** Convert open worklist items into greenfield features. */
export function itemsToFeatures(items: readonly IWorklistItem[]): IFeature[] {
  return items.map((item) => ({
    id: item.id,
    desc: item.text,
    passes: false,
    attempts: 0,
  }));
}

/** Per-item accept overrides keyed by feature id. */
export function acceptMapOf(
  items: readonly IWorklistItem[]
): Map<string, string> {
  const map = new Map<string, string>();

  for (const item of items) {
    if (item.accept !== undefined && item.accept.length > 0) {
      map.set(item.id, item.accept);
    }
  }

  return map;
}

/**
 * Resolve which worklist file to use. Explicit path wins when present;
 * otherwise PLAN.md → TASKS.md → .specs/next.md under `cwd`.
 */
export async function resolveWorklistPath(
  cwd: string,
  explicit?: string
): Promise<string | null> {
  if (explicit !== undefined && explicit.length > 0) {
    const path = isAbsolute(explicit) ? explicit : join(cwd, explicit);

    try {
      await access(path);

      return path;
    } catch {
      return null;
    }
  }

  for (const name of DEFAULT_LOOKUP) {
    const path = join(cwd, name);

    try {
      await access(path);

      return path;
    } catch {
      // try next
    }
  }

  return null;
}
