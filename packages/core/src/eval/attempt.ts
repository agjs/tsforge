import type { ILoopEvent } from "../loop/loop.types";
import type { IRunRecord } from "./eval.types";
import { analyzeEvents } from "./metrics";
import { buildRunRecord } from "./score";

export type IAttemptOutcome =
  | { failed: false; record: IRunRecord }
  /** `error` may itself be `undefined` (`throw undefined`, `Promise.reject()`), so
   *  the FLAG discriminates, never the error's presence. Keying off `error !== undefined`
   *  made a rejection with `undefined` look like a success: the caller filed an
   *  infrastructure crash as an ordinary red task and never counted it as errored. */
  | { failed: true; record: IRunRecord; error: unknown };

/**
 * Run one eval attempt and always come back with a record.
 *
 * The ONE place the crash accounting lives, shared by the `eval:sweep` campaign
 * and the self-harness evaluator — they had each written their own and each got it
 * wrong in the same direction:
 *
 * - A throw used to record `ms: 0` and no tokens, so a variant that died after
 *   several model calls read as instant and free, and looked BETTER the more often
 *   it crashed.
 * - The two paths measured different clocks (a success around the model loop only,
 *   a throw from setup onward), so `avgMs` moved with the error rate.
 * - The sweep labelled successes and failures differently, so one variant split
 *   into two buckets and its own crashes never counted against it.
 *
 * `events` and `elapsedMs` therefore belong to the CALLER: whatever the attempt
 * reported before dying is still real cost, and both outcomes are timed over the
 * same span. The label is passed in once and used for both.
 */
export async function recordAttempt(args: {
  label: string;
  events: readonly ILoopEvent[];
  elapsedMs: () => number;
  run: () => Promise<IRunRecord>;
}): Promise<IAttemptOutcome> {
  try {
    return { failed: false, record: await args.run() };
  } catch (error) {
    return {
      failed: true,
      record: {
        ...buildRunRecord({
          label: args.label,
          passed: false,
          // Unknowable after a throw. Flagged as errored so the averages that would
          // be DRAGGED DOWN by a fake 0 can skip it — a crash after N turns must not
          // improve the reported cycle count.
          cycles: 0,
          elapsedMs: args.elapsedMs(),
          metrics: analyzeEvents(args.events),
        }),
        errored: true,
      },
      error,
    };
  }
}
