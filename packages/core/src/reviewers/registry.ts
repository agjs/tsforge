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
      /** Identity of the model behind this command, when it declared one.
       *
       *  Computed where the entry was already resolved rather than looked up
       *  again later: a second lookup needs an "entry missing" branch, that
       *  branch cannot be reached, and an unreachable branch that quietly opts a
       *  reviewer out of the duplicate check is worse than no branch. */
      fingerprint?: string;
    };

export interface IPanel {
  reviewers: ResolvedReviewer[];
  minReviewers: number;
  skipped: { id: string; reason: string }[];
}

/**
 * Lowercased HOSTNAME of a base URL; the raw lowercased string if it won't parse.
 *
 * Hostname, not host. Including the port reads as more precise and is a
 * RELAXATION: it makes identity finer, so two endpoints on one machine serving
 * the same model id stop counting as one model and both get to vote. The
 * likeliest thing that looks like that is a single model served twice on one
 * box, which is the self-review this exists to prevent.
 *
 * Coarser errs toward refusing a genuine second reviewer, which is visible in
 * the skip list. Finer errs toward letting one model vote twice, which is not
 * visible at all — it just shows up as agreement.
 */
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
    ? { kept: { ...kept, fingerprint: fingerprintOf(entry) } }
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

/** Identity of a model entry: hostname and model id. */
function fingerprintOf(entry: IModelEntry): string {
  return `${normHost(entry.baseUrl)}|${entry.model.toLowerCase()}`;
}

/**
 * The identity a reviewer votes under, or null when it cannot be known.
 *
 * Null only for an UNDECLARED binary — an opaque command whose model nothing
 * reveals — and those are left alone rather than guessed at, so two undeclared
 * CLIs both vote. Declaring `fronts` is what buys the check, against other
 * reviewers as well as against the builder.
 */
function votingIdentity(reviewer: ResolvedReviewer): string | null {
  return reviewer.kind === "model"
    ? fingerprintOf(reviewer.entry)
    : (reviewer.fingerprint ?? null);
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

    const fingerprint = votingIdentity(kept);
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
