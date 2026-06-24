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
 * `res.ok`, not a throw). Fresh AbortSignal per attempt; capped linear backoff.
 * The connect completes before any stream begins, so this is safe for streaming.
 *
 * BUDGET-based, not a fixed attempt count: keep retrying transient connection
 * errors until `connectRetryMs` is exhausted. The default (~2.4s) matches the old
 * 4-attempt window so interactive stays snappy on a dead server; an unattended run
 * passes a large budget so a build RIDES OUT a model-server restart (which the old
 * 2.4s window couldn't — a 22-turn build was lost when the Spark bounced). Backoff
 * is capped (connectRetryMaxBackoffMs) so a long budget polls in modest steps.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
  connectRetryMs: number = PROVIDER_LIMITS.connectRetryMs
): Promise<Response> {
  const start = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;

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
      const elapsed = Date.now() - start;
      const backoff = Math.min(
        PROVIDER_LIMITS.retryBackoffMs * attempt,
        PROVIDER_LIMITS.connectRetryMaxBackoffMs
      );

      // A caller abort never retries; nor does a non-transient error; nor once the
      // retry budget (incl. the next backoff) would be exhausted.
      if (
        isAborted(signal) ||
        !isTransientNetworkError(err) ||
        elapsed + backoff >= connectRetryMs
      ) {
        throw err;
      }

      // Past the quick-blip window we're waiting for the endpoint to come back —
      // emit a heartbeat (stderr, captured in run logs) so a long wait isn't silent.
      if (elapsed >= PROVIDER_LIMITS.retryBackoffMs * 4) {
        console.error(
          `⏳ model endpoint unreachable — retrying (${String(Math.round(elapsed / 1000))}s elapsed, up to ${String(Math.round(connectRetryMs / 1000))}s)`
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoff);
      });
    }
  }
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
