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
  return (
    normHost(a.baseUrl) === normHost(b.baseUrl) &&
    a.model.toLowerCase() === b.model.toLowerCase()
  );
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
    return {
      ok: false,
      reason:
        "reviewer is the same model as the builder (same host + model id)",
    };
  }

  return { ok: true, reason: "" };
}

/**
 * An entry by name, or undefined — OWN properties only.
 *
 * A plain object literal inherits from Object.prototype, so `models["constructor"]`
 * (or `toString`, `valueOf`, `__proto__`) resolves to an inherited function rather
 * than undefined. A reviewer naming one would sail past the "not in models" skip
 * and reach the independence check holding something that is not a model at all.
 */
function modelEntry(
  models: Record<string, IModelEntry>,
  name: string
): IModelEntry | undefined {
  return Object.hasOwn(models, name) ? models[name] : undefined;
}

/**
 * Resolve a binary reviewer, applying the independence check when — and only
 * when — the config says which model it fronts.
 *
 * A binary is an opaque command: nothing in `argv` reveals the model behind it,
 * so this check was skipped entirely and a CLI pointed at the builder's own
 * model counted as an independent vote. That is the one thing a review panel
 * cannot tolerate, because a model agreeing with itself looks exactly like two
 * reviewers agreeing.
 *
 * An undeclared binary is still kept. There is nothing to compare it against,
 * and refusing every CLI that has not been annotated would disable working
 * panels for a risk that may not exist — but the guarantee is then only as good
 * as the config, which is why declaring it is worth doing.
 */
function resolveBinary(
  reviewer: Extract<IReviewer, { kind: "binary" }>,
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): { kept?: ResolvedReviewer; skipped?: { id: string; reason: string } } {
  const kept: ResolvedReviewer = {
    kind: "binary",
    id: reviewer.id,
    argv: reviewer.argv,
    input: reviewer.input,
    timeoutMs: reviewer.timeoutMs,
    parse: reviewer.parse,
  };

  if (reviewer.fronts === undefined) {
    return { kept };
  }

  const entry = modelEntry(cfg.models, reviewer.fronts);

  if (entry === undefined) {
    return {
      skipped: {
        id: reviewer.id,
        reason: `fronts "${reviewer.fronts}" not in models`,
      },
    };
  }

  const independence = checkModelIndependence(reviewer.fronts, entry, active);

  return independence.ok
    ? { kept }
    : { skipped: { id: reviewer.id, reason: independence.reason } };
}

function resolveOne(
  reviewer: IReviewer,
  cfg: IModelsConfig,
  active: { name: string; entry: IModelEntry }
): { kept?: ResolvedReviewer; skipped?: { id: string; reason: string } } {
  if (reviewer.kind === "binary") {
    return resolveBinary(reviewer, cfg, active);
  }

  // Same own-property lookup as the binary path: this line had the identical
  // prototype hole, and only the new one was flagged.
  const entry = modelEntry(cfg.models, reviewer.entry);

  if (entry === undefined) {
    return {
      skipped: {
        id: reviewer.id,
        reason: `entry "${reviewer.entry}" not in models`,
      },
    };
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
  const minReviewers = Math.max(
    MIN_REVIEWERS_FLOOR,
    panel?.minReviewers ?? MIN_REVIEWERS_FLOOR
  );
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
