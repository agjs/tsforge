/**
 * Concurrency-capped work-unit scheduler — the execution core for multiagent
 * fan-out. Units are plain `(signal) => Promise<T>` thunks so a single
 * `provider.complete()` call (review find/verify units) and a full agent loop
 * (Phase B AgentRunner) schedule identically. cap=1 degrades to today's
 * sequential behavior, which is a first-class path on serializing local
 * endpoints, not an afterthought.
 */

/** One schedulable piece of work. `id` labels progress events and the agent
 *  tree row (e.g. `find:src/auth.ts`). */
export interface IScheduledUnit<T> {
  readonly id: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

export type UnitStatus = "pending" | "start" | "done" | "failed";

export interface ISchedulerOptions {
  /** Max units in flight at once. Clamped to an integer ≥ 1; default 1. */
  readonly concurrency?: number;
  /** Master abort: pending units never start; each running unit's own signal
   *  fires so it can stop early. */
  readonly signal?: AbortSignal;
  /** Progress callback per unit transition (drives logs / the agent tree). */
  readonly onUnit?: (id: string, status: UnitStatus) => void;
}

/** Clamp a requested cap to a sane integer ≥ 1 (fractions floor, junk → 1). */
export function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export class AgentScheduler {
  private readonly concurrency: number;
  private readonly signal?: AbortSignal;
  private readonly onUnit?: (id: string, status: UnitStatus) => void;

  constructor(opts: ISchedulerOptions = {}) {
    this.concurrency = clampConcurrency(opts.concurrency);

    if (opts.signal !== undefined) {
      this.signal = opts.signal;
    }

    if (opts.onUnit !== undefined) {
      this.onUnit = opts.onUnit;
    }
  }

  /** Run one unit under the master signal; a throw degrades to null. */
  private async runUnit<T>(unit: IScheduledUnit<T>): Promise<T | null> {
    const ctrl = new AbortController();

    const onAbort = (): void => {
      ctrl.abort();
    };

    // An already-aborted parent never re-fires "abort" — flag the unit's own
    // signal directly instead of registering a listener that can't trigger.
    if (this.signal?.aborted === true) {
      ctrl.abort();
    } else {
      this.signal?.addEventListener("abort", onAbort, { once: true });
    }

    this.onUnit?.(unit.id, "start");

    try {
      const result = await unit.run(ctrl.signal);

      this.onUnit?.(unit.id, "done");

      return result;
    } catch {
      // One failed unit degrades to a null slot; siblings keep running.
      this.onUnit?.(unit.id, "failed");

      return null;
    } finally {
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Run all units with at most `concurrency` in flight. Results come back in
   * SUBMISSION order (never completion order), one slot per unit; a failed or
   * never-started (master-aborted) unit's slot is null.
   */
  async runParallel<T>(
    units: readonly IScheduledUnit<T>[]
  ): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array<T | null>(units.length).fill(null);
    let next = 0;

    // Announce every unit up-front so progress denominators are stable from
    // the first update (the tree renders pending rows, not a growing total).
    for (const unit of units) {
      this.onUnit?.(unit.id, "pending");
    }

    const worker = async (): Promise<void> => {
      while (next < units.length && this.signal?.aborted !== true) {
        const index = next;

        next += 1;

        const unit = units[index];

        if (unit !== undefined) {
          results[index] = await this.runUnit(unit);
        }
      }
    };

    const lanes = Math.min(this.concurrency, Math.max(units.length, 1));

    await Promise.all(Array.from({ length: lanes }, worker));

    return results;
  }
}
