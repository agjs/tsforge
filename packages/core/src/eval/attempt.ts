import type { ILoopEvent } from "../loop/loop.types";
import type { IRunRecord } from "./eval.types";
import { analyzeEvents } from "./metrics";
import { buildRunRecord } from "./score";

export interface IAttemptOutcome {
  record: IRunRecord;
  /** The failure, when the attempt threw. `undefined` on success. */
  error?: unknown;
}

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
    return { record: await args.run() };
  } catch (error) {
    return {
      record: buildRunRecord({
        label: args.label,
        passed: false,
        cycles: 0,
        elapsedMs: args.elapsedMs(),
        metrics: analyzeEvents(args.events),
      }),
      error,
    };
  }
}
