import { PROVIDER_LIMITS } from "./inference.constants";

// Transient CONNECTION failures (the box blipped / socket dropped) — retry these.
// Deliberately does NOT match timeouts: a request that ran past timeoutMs is a
// reasoning spiral, not a blip, and retrying would just waste another timeout.
const TRANSIENT_NETWORK =
  /unable to connect|socket connection|connection (was )?(closed|refused|reset)|econnrefused|econnreset/i;

function isTransientNetworkError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_NETWORK.test(err.message);
}

/**
 * Retry a request on transient connection failures only (HTTP errors surface via
 * `res.ok`, not a throw). Fresh AbortSignal per attempt; small linear backoff.
 * The connect completes before any stream begins, so this is safe for streaming.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const maxAttempts = 4;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A caller abort (Ctrl-C) is terminal — don't start another attempt.
    if (isAborted(signal)) {
      throw signalReason(signal);
    }

    // Per-attempt timeout, combined with the caller's cancellation — the latter
    // also aborts the streaming body (the connect finishes before the stream).
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal =
      signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

    try {
      return await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: attemptSignal,
      });
    } catch (err) {
      lastErr = err;

      // A caller abort never retries (it isn't a transient network blip).
      if (
        isAborted(signal) ||
        !isTransientNetworkError(err) ||
        attempt === maxAttempts
      ) {
        throw err;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, PROVIDER_LIMITS.retryBackoffMs * attempt);
      });
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}

/** Read `aborted` through a function boundary so the loop-level narrowing (which
 *  can't see the async abort mutate it mid-await) doesn't collapse the type. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** The Error an aborted signal carries (or a generic one). */
function signalReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}
