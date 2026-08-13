import { MEMORY_START_TIMEOUT_MS } from "./provider.types";
import { trace } from "../../lib/trace";

/**
 * Resolve `work`, or mark timed out when it has not settled within `ms`.
 */
export async function withDeadlineResult<T>(
  work: Promise<T>,
  ms: number
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
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
  ms: number = MEMORY_START_TIMEOUT_MS
): Promise<T> {
  const result = await withDeadlineResult(work, ms);

  return result.timedOut ? fallback : result.value;
}
