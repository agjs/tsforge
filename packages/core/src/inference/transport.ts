import { LIMITS } from "../constants";

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
  timeoutMs: number
): Promise<Response> {
  const maxAttempts = 4;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err;

      if (!isTransientNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, LIMITS.retryBackoffMs * attempt);
      });
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}
