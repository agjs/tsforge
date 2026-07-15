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
  ) => Promise<{ ok: boolean; stdout: string }>;
}

function reviewFrom(id: string, rawText: string): ReviewOutcome {
  let review: IReview | null;

  try {
    review = parseReview(id, JSON.parse(extractJson(rawText)));
  } catch {
    review = null;
  }

  return review === null
    ? { status: "errored", reviewerId: id, error: "unparseable review output" }
    : { status: "ok", review };
}

async function invokeModel(
  reviewer: Extract<ResolvedReviewer, { kind: "model" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  try {
    const res = await deps.makeProvider(reviewer.entry).complete([
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: renderReviewPrompt(request) },
    ]);

    return reviewFrom(reviewer.id, res.content);
  } catch (err) {
    return {
      status: "errored",
      reviewerId: reviewer.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** For `json-fence`, extract the last ```json block; for `raw`, use stdout as-is.
 *  Both then flow through the same JSON+schema guard, so a fence miss → errored. */
function extractBinaryJson(stdout: string): string {
  const matches = [...stdout.matchAll(/```json\s*([\s\S]*?)```/gu)];
  const last = matches.at(-1);

  return last?.[1] ?? stdout;
}

async function invokeBinary(
  reviewer: Extract<ResolvedReviewer, { kind: "binary" }>,
  request: IReviewRequest,
  deps: IInvokeDeps
): Promise<ReviewOutcome> {
  try {
    const stdin = renderReviewPrompt(request);
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

    const payload =
      reviewer.parse === "json-fence"
        ? extractBinaryJson(res.stdout)
        : res.stdout;

    return reviewFrom(reviewer.id, payload);
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
