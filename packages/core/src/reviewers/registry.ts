import { modelByName } from "../models-config";
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
      /** Carried through from config so the panel can tell whether two reviewers
       *  are the same model. Absent when the binary did not declare one. */
      fronts?: string;
    };

export interface IPanel {
  reviewers: ResolvedReviewer[];
  minReviewers: number;
  skipped: { id: string; reason: string }[];
}

/** Lowercased host AND PORT of a base URL; the raw lowercased string if it won't
 *  parse. The port matters: two endpoints on one machine — :8888 and :9999 —
 *  are genuinely different models however alike their ids, and dropping it
 *  collapses them into one. */
function normHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
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
    ...(reviewer.fronts === undefined ? {} : { fronts: reviewer.fronts }),
  };

  if (reviewer.fronts === undefined) {
    return { kept };
  }

  const entry = modelByName(cfg.models, reviewer.fronts);

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
  const entry = modelByName(cfg.models, reviewer.entry);

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

/**
 * A stable identity for the model behind a reviewer, or null when it cannot be
 * known.
 *
 * Null for an UNDECLARED binary — an opaque command whose model nothing reveals
 * — and those are left alone rather than guessed at, so two undeclared CLIs are
 * both kept. Declaring `fronts` is what buys the check, here as well as against
 * the builder.
 */
function modelFingerprint(
  reviewer: ResolvedReviewer,
  cfg: IModelsConfig
): string | null {
  if (reviewer.kind === "model") {
    return `${normHost(reviewer.entry.baseUrl)}|${reviewer.entry.model.toLowerCase()}`;
  }

  const fronts = reviewer.fronts;

  if (fronts === undefined) {
    return null;
  }

  // Not a fail-open `undefined -> null`: resolveBinary already returned `skipped`
  // for a fronts that names nothing, so anything reaching here resolves. An
  // unreachable branch that quietly opts a reviewer out of the check is worse
  // than no branch.
  const entry = modelByName(cfg.models, fronts);

  return entry === undefined
    ? null
    : `${normHost(entry.baseUrl)}|${entry.model.toLowerCase()}`;
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

  // Which models are already voting. Independence was only ever checked against
  // the BUILDER, so two reviewers fronting one model both counted and a single
  // model cast two votes — a panel that agrees with itself while reporting
  // agreement of 2, which is the number the whole gate is read through.
  const voting = new Map<string, string>();

  for (const r of panel?.reviewers ?? []) {
    const { kept, skipped: skip } = resolveOne(r, cfg, active);

    if (skip !== undefined) {
      skipped.push(skip);
    }

    if (kept === undefined) {
      continue;
    }

    const fingerprint = modelFingerprint(kept, cfg);
    const already = fingerprint === null ? undefined : voting.get(fingerprint);

    if (already !== undefined) {
      skipped.push({
        id: kept.id,
        reason: `same model as reviewer "${already}" — one model, one vote`,
      });
      continue;
    }

    if (fingerprint !== null) {
      voting.set(fingerprint, kept.id);
    }

    reviewers.push(kept);
  }

  return { reviewers, minReviewers, skipped };
}
