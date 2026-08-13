import { MEMORY_START_TIMEOUT_MS } from "./provider.types";
import { trace } from "../../lib/trace";

/**
 * Resolve `work`, or mark timed out when it has not settled within `ms`.
 *
 * When `abort` is provided, it is aborted on timeout so in-flight work that
 * honors the signal (e.g. `provider.complete`) actually stops — a bare race
 * leaves the orphaned promise holding the connection.
 */
export async function withDeadlineResult<T>(
  work: Promise<T>,
  ms: number,
  opts?: { readonly abort?: AbortController }
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      opts?.abort?.abort();
      trace("session.decision-memory", `timed out after ${ms}ms`);
      resolve({ timedOut: true });
    }, ms);
  });

  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve `work`, or `fallback` when it has not settled within `ms`.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  fallback: T,
  ms: number = MEMORY_START_TIMEOUT_MS,
  opts?: { readonly abort?: AbortController }
): Promise<T> {
  const result = await withDeadlineResult(work, ms, opts);

  return result.timedOut ? fallback : result.value;
}
