import type {
  IModelsConfig,
  IModelEntry,
  IReviewer,
  BinaryInputMode,
  BinaryParseMode,
} from "../models-config";

export const MIN_REVIEWERS_FLOOR = 2;

export type ResolvedReviewer =
  | { kind: "model"; id: string; entry: IModelEntry }
  | {
      kind: "binary";
      id: string;
      argv: string[];
      input: BinaryInputMode;
      timeoutMs: number;
      parse: BinaryParseMode;
    };

export interface IPanel {
  reviewers: ResolvedReviewer[];
  minReviewers: number;
  skipped: { id: string; reason: string }[];
}

/** Lowercased hostname of a base URL; the raw lowercased string if it won't parse. */
function normHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

function sameModel(a: IModelEntry, b: IModelEntry): boolean {
  return normHost(a.baseUrl) === normHost(b.baseUrl) && a.model.toLowerCase() === b.model.toLowerCase();
}

interface IIndependence {
  ok: boolean;
  reason: string;
}

function checkModelIndependence(
  entryName: string,
  entry: IModelEntry,
  active: { name: string; entry: IModelEntry }
): IIndependence {
  if (entryName === active.name) {
    return { ok: false, reason: "reviewer is the active builder entry" };
  }

  if (sameModel(entry, active.entry)) {
    return { ok: false, reason: "reviewer is the same model as the builder (same host + model id)" };
  }

  return { ok: true, reason: "" };
}

function resolveOne(
  reviewer: IReviewer,
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): { kept?: ResolvedReviewer; skipped?: { id: string; reason: string } } {
  if (reviewer.kind === "binary") {
    return {
      kept: {
        kind: "binary",
        id: reviewer.id,
        argv: reviewer.argv,
        input: reviewer.input,
        timeoutMs: reviewer.timeoutMs,
        parse: reviewer.parse,
      },
    };
  }

  const entry = cfg.models[reviewer.entry];

  if (entry === undefined) {
    return { skipped: { id: reviewer.id, reason: `entry "${reviewer.entry}" not in models` } };
  }

  const independence = checkModelIndependence(reviewer.entry, entry, active);

  return independence.ok
    ? { kept: { kind: "model", id: reviewer.id, entry } }
    : { skipped: { id: reviewer.id, reason: independence.reason } };
}

export function resolvePanel(
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): IPanel {
  const panel = cfg.reviewPanel;
  const minReviewers = Math.max(MIN_REVIEWERS_FLOOR, panel?.minReviewers ?? MIN_REVIEWERS_FLOOR);
  const reviewers: ResolvedReviewer[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const r of panel?.reviewers ?? []) {
    const { kept, skipped: skip } = resolveOne(r, cfg, active);

    if (kept !== undefined) {
      reviewers.push(kept);
    }

    if (skip !== undefined) {
      skipped.push(skip);
    }
  }

  return { reviewers, minReviewers, skipped };
}
