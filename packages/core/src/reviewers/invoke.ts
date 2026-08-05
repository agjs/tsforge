import type { IProvider } from "../inference";
import type { IModelEntry, BinaryInputMode } from "../models-config";
import { extractJson } from "../lib/json/json";
import type { IPanel, ResolvedReviewer } from "./registry";
import {
  parseReview,
  renderReviewPrompt,
  REVIEW_SYSTEM_PROMPT,
  type IReview,
  type IReviewRequest,
} from "./schema";
import type { ReviewOutcome } from "./aggregate";

export const REVIEWER_CONCURRENCY = 5;

export interface IInvokeDeps {
  makeProvider: (entry: IModelEntry) => IProvider;
  runBinary: (
    r: { argv: string[]; input: BinaryInputMode; timeoutMs: number },
    stdin: string
    // REQUIRED, not optional. Optional means an existing or alternative runner
    // compiles without reporting it, and every omitted timeout is then
    // classified as a non-zero exit — restoring the exact conflation this
    // change exists to remove, silently.
  ) => Promise<{ ok: boolean; stdout: string; timedOut: boolean }>;
}

function reviewFrom(id: string, rawText: string, ms: number): ReviewOutcome {
  let review: IReview | null;

  try {
    review = parseReview(id, JSON.parse(extractJson(rawText)));
  } catch {
    review = null;
  }

  return review === null
    ? {
        status: "errored",
        reviewerId: id,
        error: "unparseable review output",
        cause: "unparseable",
        ms,
      }
    : { status: "ok", review, ms };
}

async function invokeModel(
  reviewer: Extract<ResolvedReviewer, { kind: "model" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  const started = Date.now();

  try {
    const res = await deps.makeProvider(reviewer.entry).complete([
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: renderReviewPrompt(request) },
    ]);

    return reviewFrom(reviewer.id, res.content, Date.now() - started);
  } catch (err) {
    return {
      status: "errored",
      reviewerId: reviewer.id,
      error: err instanceof Error ? err.message : String(err),
      cause: "threw",
      ms: Date.now() - started,
    };
  }
}

/** For `json-fence`, extract the last ```json block; for `raw`, use stdout as-is.
 *  Both then flow through the same JSON+schema guard, so a fence miss → errored. */
export function extractBinaryJson(stdout: string): string {
  const matches = [...stdout.matchAll(/```json\s*([\s\S]*?)```/gu)];
  const last = matches.at(-1);

  return last?.[1] ?? stdout;
}

async function invokeBinary(
  reviewer: Extract<ResolvedReviewer, { kind: "binary" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  const started = Date.now();

  try {
    // Binaries have no separate system channel, so the review contract (JSON
    // schema + reject-by-default + rubric) must be prepended to their single
    // prompt — otherwise the binary emits prose, parseReview returns null, and
    // the reviewer is always `errored` (which would silently break grok, the
    // headline binary reviewer). Model reviewers get this via the system message.
    const stdin = `${REVIEW_SYSTEM_PROMPT}\n\n${renderReviewPrompt(request)}`;
    const res = await deps.runBinary(
      {
        argv: reviewer.argv,
        input: reviewer.input,
        timeoutMs: reviewer.timeoutMs,
      },
      stdin
    );

    // Checked BEFORE ok, not inside the failure branch. runBinary already forces
    // ok=false on a kill, but this must not depend on that: any runner meeting
    // the contract could report `ok: true, timedOut: true`, and reading stdout
    // there would count a reviewer we killed mid-sentence as having reviewed.
    // Whatever it printed before the kill is a partial answer, and a partial
    // answer is not a review.
    if (res.timedOut) {
      return {
        status: "errored",
        reviewerId: reviewer.id,
        error: `binary hit its ${String(reviewer.timeoutMs)}ms timeout`,
        cause: "timeout",
        ms: Date.now() - started,
      };
    }

    // Timeout and non-zero exit are DIFFERENT facts and the old message reported
    // them as one. A timeout means the budget is too small for the work — raise
    // it, or drop the reviewer. A non-zero exit means the binary is broken and
    // the budget is irrelevant. Told apart, the fix is obvious; conflated, the
    // only way to find out is to time the binary by hand.
    if (!res.ok) {
      return {
        status: "errored",
        reviewerId: reviewer.id,
        error: "binary exited non-zero",
        cause: "exit",
        ms: Date.now() - started,
      };
    }

    const payload =
      reviewer.parse === "json-fence"
        ? extractBinaryJson(res.stdout)
        : res.stdout;

    return reviewFrom(reviewer.id, payload, Date.now() - started);
  } catch (err) {
    return {
      status: "errored",
      reviewerId: reviewer.id,
      error: err instanceof Error ? err.message : String(err),
      cause: "threw",
      ms: Date.now() - started,
    };
  }
}

function invokeOne(
  r: ResolvedReviewer,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  return r.kind === "model"
    ? invokeModel(r, request, deps)
    : invokeBinary(r, request, deps);
}

/** Run all reviewers with a small concurrency cap; every reviewer resolves to an
 *  outcome (never rejects) so one failure can't sink the panel. */
export async function reviewerInvoke(
  panel: IPanel,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome[]> {
  const queue = [...panel.reviewers];
  const results: ReviewOutcome[] = [];

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
