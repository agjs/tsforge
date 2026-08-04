/** Bounded-concurrency task pool: input-ordered results, all-settled failure
 *  reporting, and cooperative cancellation on the first rejection. */
export function pool<T>(
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  limit: number
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }

  return run(tasks, limit);
}

async function run<T>(
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const errors: { index: number; error: unknown }[] = [];
  const controller = new AbortController();
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;

      next += 1;

      if (index >= tasks.length || controller.signal.aborted) {
        return;
      }

      const task = tasks[index];

      if (task === undefined) {
        return;
      }

      try {
        results[index] = await task(controller.signal);
      } catch (error) {
        errors.push({ index, error });
        controller.abort();
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker()
  );

  await Promise.all(workers);

  if (errors.length > 0) {
    errors.sort((a, b) => a.index - b.index);

    throw new AggregateError(
      errors.map((e) => e.error),
      "one or more tasks failed"
    );
  }

  return results;
}
