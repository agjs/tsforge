import { extractJson } from "../lib/json/json";
import type { IPanel, ResolvedReviewer } from "./registry";
import { REVIEWER_CONCURRENCY, type IInvokeDeps } from "./invoke";
import {
  parseDiagnosis,
  renderDiagnosePrompt,
  DIAGNOSE_SYSTEM_PROMPT,
  FAILURE_CATEGORIES,
  type IDiagnosis,
  type IDiagnoseRequest,
  type FailureCategory,
} from "./diagnose-schema";

export type DiagOutcome =
  | { status: "ok"; diagnosis: IDiagnosis }
  | { status: "errored"; reviewerId: string; error: string };

function diagFrom(id: string, rawText: string): DiagOutcome {
  let d: IDiagnosis | null;

  try {
    d = parseDiagnosis(id, JSON.parse(extractJson(rawText)));
  } catch {
    d = null;
  }

  return d === null
    ? {
        status: "errored",
        reviewerId: id,
        error: "unparseable diagnosis output",
      }
    : { status: "ok", diagnosis: d };
}

async function invokeModel(
  reviewer: Extract<ResolvedReviewer, { kind: "model" }>,
  request: IDiagnoseRequest,
  deps: IInvokeDeps
): Promise<DiagOutcome> {
  try {
    const res = await deps.makeProvider(reviewer.entry).complete([
      { role: "system", content: DIAGNOSE_SYSTEM_PROMPT },
      { role: "user", content: renderDiagnosePrompt(request) },
    ]);

    return diagFrom(reviewer.id, res.content);
  } catch (err) {
    return {
      status: "errored",
      reviewerId: reviewer.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function invokeBinary(
  reviewer: Extract<ResolvedReviewer, { kind: "binary" }>,
  request: IDiagnoseRequest,
  deps: IInvokeDeps
): Promise<DiagOutcome> {
  try {
    // Binaries have no separate system channel, so the contract is prepended to
    // the single prompt — same treatment the review path gives them.
    const stdin = `${DIAGNOSE_SYSTEM_PROMPT}\n\n${renderDiagnosePrompt(request)}`;
    const res = await deps.runBinary(
      {
        argv: reviewer.argv,
        input: reviewer.input,
        timeoutMs: reviewer.timeoutMs,
      },
      stdin
    );

    if (!res.ok) {
      return {
        status: "errored",
        reviewerId: reviewer.id,
        error: "binary exited non-zero or timed out",
      };
    }

    return diagFrom(reviewer.id, res.stdout);
  } catch (err) {
    return {
      status: "errored",
      reviewerId: reviewer.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function invokeOne(
  r: ResolvedReviewer,
  request: IDiagnoseRequest,
  deps: IInvokeDeps
): Promise<DiagOutcome> {
  return r.kind === "model"
    ? invokeModel(r, request, deps)
    : invokeBinary(r, request, deps);
}

/** Run every reviewer with the diagnosis contract; each resolves to an outcome
 *  (never rejects) so one failure can't sink the panel. Mirrors reviewerInvoke. */
export async function diagnoseInvoke(
  panel: IPanel,
  request: IDiagnoseRequest,
  deps: IInvokeDeps
): Promise<DiagOutcome[]> {
  const queue = [...panel.reviewers];
  const results: DiagOutcome[] = [];

  async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.push(await invokeOne(next, request, deps));
    }
  }

  const workers = Array.from(
    { length: Math.min(REVIEWER_CONCURRENCY, panel.reviewers.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

export interface IConsensusVote {
  reviewerId: string;
  category: FailureCategory;
  confidence: IDiagnosis["confidence"];
  rootCause: string;
  suggestedFix: string;
}

export interface IConsensus {
  category: FailureCategory | null; // null when no reviewer succeeded
  agreement: number; // how many reviewers picked the consensus category
  totalOk: number; // successful reviewers
  totalErrored: number;
  votes: IConsensusVote[];
  suggestedFixes: string[]; // distinct fixes from reviewers who voted the consensus
}

/** Fuse diagnoses into a consensus: the most-voted category wins (ties broken by
 *  FAILURE_CATEGORIES order — most-structural first), and we surface the fixes
 *  proposed by the reviewers who agreed on it. Errored reviewers are counted but
 *  never vote. */
export function aggregateDiagnoses(outcomes: DiagOutcome[]): IConsensus {
  const votes: IConsensusVote[] = [];
  let errored = 0;

  for (const o of outcomes) {
    if (o.status === "ok") {
      votes.push({
        reviewerId: o.diagnosis.reviewerId,
        category: o.diagnosis.category,
        confidence: o.diagnosis.confidence,
        rootCause: o.diagnosis.rootCause,
        suggestedFix: o.diagnosis.suggestedFix,
      });
    } else {
      errored += 1;
    }
  }

  if (votes.length === 0) {
    return {
      category: null,
      agreement: 0,
      totalOk: 0,
      totalErrored: errored,
      votes: [],
      suggestedFixes: [],
    };
  }

  const counts = new Map<FailureCategory, number>();

  for (const v of votes) {
    counts.set(v.category, (counts.get(v.category) ?? 0) + 1);
  }

  let best: FailureCategory = votes[0]?.category ?? "other";
  let bestCount = 0;

  // Iterate categories in canonical order so a tie resolves deterministically to
  // the earlier (more structural) category.
  for (const cat of FAILURE_CATEGORIES) {
    const c = counts.get(cat) ?? 0;

    if (c > bestCount) {
      best = cat;
      bestCount = c;
    }
  }

  const suggestedFixes = [
    ...new Set(
      votes.filter((v) => v.category === best).map((v) => v.suggestedFix)
    ),
  ];

  return {
    category: best,
    agreement: bestCount,
    totalOk: votes.length,
    totalErrored: errored,
    votes,
    suggestedFixes,
  };
}
