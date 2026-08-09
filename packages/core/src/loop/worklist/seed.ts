/**
 * Plan-mode approve → session-bound plan under `.tsforge/worklist/plans/`.
 * The model emits fenced JSON; the harness only extracts, validates, and persists.
 */
import type {
  ChecklistItemKind,
  IChecklistItem,
  IChecklistItemDraft,
  IPlanDocument,
  IPlanDraft,
} from "./checklist.types";
import { savePlan } from "./checklist-store";

function parseKind(v: unknown): ChecklistItemKind | undefined {
  if (v === "investigate" || v === "create" || v === "modify" || v === "test") {
    return v;
  }

  return undefined;
}

export type SeedWorklistResult =
  | { readonly ok: true; readonly plan: IPlanDocument }
  | { readonly ok: false; readonly error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Prefer ```json … ```; else any fenced block that parses as a plan draft. */
export function extractPlanJson(assistantText: string): unknown {
  const fences = [
    ...assistantText.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/giu),
  ];

  for (const match of fences) {
    const body = match[1]?.trim() ?? "";

    if (body.length === 0) {
      continue;
    }

    try {
      return JSON.parse(body);
    } catch {
      // try next fence
    }
  }

  return null;
}

function normalizeItem(draft: IChecklistItemDraft): IChecklistItem | null {
  const title = draft.title.trim();

  if (title.length === 0) {
    return null;
  }

  const children: IChecklistItem[] = [];

  if (draft.children) {
    for (const child of draft.children) {
      const normalized = normalizeItem(child);

      if (normalized === null) {
        return null;
      }

      children.push(normalized);
    }
  }

  const status =
    draft.status === "pending" ||
    draft.status === "active" ||
    draft.status === "done" ||
    draft.status === "blocked"
      ? draft.status
      : "pending";

  return {
    id:
      typeof draft.id === "string" && draft.id.length > 0
        ? draft.id
        : crypto.randomUUID(),
    title,
    status,
    ...(typeof draft.detail === "string" && draft.detail.trim().length > 0
      ? { detail: draft.detail }
      : {}),
    ...(draft.files !== undefined &&
    draft.files.length > 0 &&
    draft.files.every((f) => typeof f === "string")
      ? { files: [...draft.files] }
      : {}),
    ...(typeof draft.verify === "string" && draft.verify.trim().length > 0
      ? { verify: draft.verify }
      : {}),
    ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
    ...(typeof draft.blockedReason === "string" &&
    draft.blockedReason.trim().length > 0
      ? { blockedReason: draft.blockedReason }
      : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function parseDraftItem(raw: unknown): IChecklistItemDraft | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.title !== "string") {
    return null;
  }

  let children: IChecklistItemDraft[] | undefined;

  if (Array.isArray(raw.children)) {
    children = [];

    for (const c of raw.children) {
      const parsed = parseDraftItem(c);

      if (parsed === null) {
        return null;
      }

      children.push(parsed);
    }
  }

  const kind = parseKind(raw.kind);

  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    title: raw.title,
    ...(raw.status === "pending" ||
    raw.status === "active" ||
    raw.status === "done" ||
    raw.status === "blocked"
      ? { status: raw.status }
      : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(Array.isArray(raw.files) &&
    raw.files.every((f): f is string => typeof f === "string")
      ? { files: raw.files }
      : {}),
    ...(typeof raw.verify === "string" ? { verify: raw.verify } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof raw.blockedReason === "string"
      ? { blockedReason: raw.blockedReason }
      : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

export function parsePlanDraft(raw: unknown): IPlanDraft | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return null;
  }

  const items: IChecklistItemDraft[] = [];

  for (const item of raw.items) {
    const parsed = parseDraftItem(item);

    if (parsed === null) {
      return null;
    }

    items.push(parsed);
  }

  return {
    ...(typeof raw.goal === "string" ? { goal: raw.goal } : {}),
    items,
  };
}

export type NormalizePlanResult =
  | { readonly ok: true; readonly plan: IPlanDocument }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a plan draft and normalize UUIDs / pending status. Does not write disk.
 */
export function normalizePlanDraft(
  draft: IPlanDraft,
  fallbackGoal: string
): NormalizePlanResult {
  const items: IChecklistItem[] = [];

  for (const item of draft.items) {
    const normalized = normalizeItem(item);

    if (normalized === null) {
      return {
        ok: false,
        error: "plan has an item with an empty title",
      };
    }

    items.push(normalized);
  }

  if (items.length === 0) {
    return { ok: false, error: "plan needs a non-empty items tree" };
  }

  const goalFromDraft = draft.goal?.trim() ?? "";
  const goal =
    goalFromDraft.length > 0
      ? goalFromDraft
      : fallbackGoal.trim().length > 0
        ? fallbackGoal.trim()
        : "goal";
  const now = new Date().toISOString();

  return {
    ok: true,
    plan: {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      goal,
      activeItemId: null,
      updatedAt: now,
      items,
    },
  };
}

/** Normalize unknown JSON (tool args or extracted fence) into a plan document. */
export function planDocumentFromUnknown(
  raw: unknown,
  fallbackGoal: string
): NormalizePlanResult {
  const draft = parsePlanDraft(raw);

  if (draft === null) {
    return {
      ok: false,
      error:
        "plan invalid — need non-empty items[] with title on each node (optional detail/files/verify/children)",
    };
  }

  return normalizePlanDraft(draft, fallbackGoal);
}

/** Persist an already-normalized plan (approve path). */
export function persistPlanDocument(
  cwd: string,
  plan: IPlanDocument
): IPlanDocument {
  const stamped: IPlanDocument = {
    ...plan,
    updatedAt: new Date().toISOString(),
  };

  savePlan(cwd, stamped);

  return stamped;
}

/**
 * Extract fenced plan JSON from the last assistant message, validate, normalize
 * UUIDs, write `plans/<planId>.json` + index, return the document.
 * Prefer `present_plan` + pending proposal; this remains a fallback.
 */
export function seedWorklistFromPlan(
  cwd: string,
  assistantText: string,
  fallbackGoal: string
): SeedWorklistResult {
  const extracted = extractPlanJson(assistantText);

  if (extracted === null) {
    return {
      ok: false,
      error:
        "no plan yet — call present_plan with { goal, items }, or emit a fenced JSON plan, then approve",
    };
  }

  const normalized = planDocumentFromUnknown(extracted, fallbackGoal);

  if (!normalized.ok) {
    return normalized;
  }

  return { ok: true, plan: persistPlanDocument(cwd, normalized.plan) };
}

/** First user message text in the session (plan intent), clipped. */
export function goalFromMessages(
  messages: readonly { role: string; content: string }[]
): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    let text = message.content.trim();

    if (text.length === 0) {
      continue;
    }

    // PLAN_MODE_NOTE is appended to the first user send — keep the ask only.
    const noteAt = text.indexOf("\n\n[PLAN MODE");

    if (noteAt >= 0) {
      text = text.slice(0, noteAt).trim();
    }

    if (
      text.length === 0 ||
      /^(approve|approved|go|lgtm|implement)[.!]?$/i.test(text)
    ) {
      continue;
    }

    const line = text.split("\n")[0]?.trim() ?? text;

    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }

  return "goal";
}
