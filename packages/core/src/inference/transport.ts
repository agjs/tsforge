import { PROVIDER_LIMITS } from "./inference.constants";

// Transient CONNECTION failures (the box blipped / socket dropped) — retry these.
// Deliberately does NOT match timeouts: a request that ran past timeoutMs is a
// reasoning spiral, not a blip, and retrying would just waste another timeout.
const TRANSIENT_NETWORK =
  /unable to connect|socket connection|connection (was )?(closed|refused|reset)|econnrefused|econnreset|fetch failed/i;

/** Error codes for the same class, as Node/undici report them. */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** HTTP statuses worth retrying under the same budget: rate limit + the
 *  gateway/overload family a restarting vLLM (or a proxy in front of it)
 *  answers with. 4xx other than 429 is a permanent request problem. */
const RETRYABLE_HTTP = new Set([429, 502, 503, 529]);

/** How deep to walk `cause` chains / AggregateError fans before giving up. */
const CAUSE_DEPTH = 8;

/**
 * Transient-connection classification that survives runtimes: Bun puts the
 * story in `err.message`; Node/undici throw `TypeError: fetch failed` with the
 * real ECONNREFUSED buried in `err.cause` (often inside an AggregateError).
 * The old message-only regex meant the whole ride-out-a-restart feature was a
 * no-op off Bun — one refused connect and the turn died on attempt 1.
 */
function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (depth > CAUSE_DEPTH || !(err instanceof Error)) {
    return false;
  }

  if (TRANSIENT_NETWORK.test(err.message)) {
    return true;
  }

  if ("code" in err) {
    const code: unknown = err.code;

    if (typeof code === "string" && TRANSIENT_CODES.has(code)) {
      return true;
    }
  }

  if (err instanceof AggregateError) {
    return err.errors.some((e) => isTransientNetworkError(e, depth + 1));
  }

  return isTransientNetworkError(err.cause, depth + 1);
}

/** Seconds to wait from a Retry-After header (integer form only — HTTP-date
 *  is rare on the endpoints we target), bounded so a hostile/buggy header
 *  can't park the loop; null when absent/unparseable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");

  if (raw === null || !/^\d+$/.test(raw.trim())) {
    return null;
  }

  const ms = Number(raw.trim()) * 1000;

  return Math.min(ms, PROVIDER_LIMITS.connectRetryMaxBackoffMs * 4);
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
 *
 * 429/502/503/529 responses retry under the SAME budget (honoring an integer
 * Retry-After): a rate-limit blip or a proxy hiccup used to end the turn as if
 * the request were permanently wrong. Retrying happens strictly BEFORE any
 * stream body is read — the invariant the connect retry already relies on. At
 * budget exhaustion the response is RETURNED (not thrown) so every caller sees
 * exactly the status handling it had before.
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
    const backoff = Math.min(
      PROVIDER_LIMITS.retryBackoffMs * attempt,
      PROVIDER_LIMITS.connectRetryMaxBackoffMs
    );

    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: attemptSignal,
      });

      if (!RETRYABLE_HTTP.has(res.status)) {
        return res;
      }

      const wait = retryAfterMs(res) ?? backoff;
      const elapsed = Date.now() - start;

      if (isAborted(signal) || elapsed + wait >= connectRetryMs) {
        // Budget spent: hand the response back — the caller's status handling
        // (ModelRequestError with the real status) is unchanged.
        return res;
      }

      // Free the socket before waiting; nobody will read this body.
      await res.body?.cancel().catch(() => undefined);
      heartbeat(elapsed, connectRetryMs, `HTTP ${String(res.status)}`);
      await abortableDelay(wait, signal);
      continue;
    } catch (err) {
      const elapsed = Date.now() - start;

      // A caller abort never retries; nor does a non-transient error; nor once the
      // retry budget (incl. the next backoff) would be exhausted.
      if (
        isAborted(signal) ||
        !isTransientNetworkError(err) ||
        elapsed + backoff >= connectRetryMs
      ) {
        throw err;
      }

      heartbeat(elapsed, connectRetryMs, "endpoint unreachable");
      await abortableDelay(backoff, signal);
    }
  }
}

/** Past the quick-blip window we're waiting for the endpoint to come back —
 *  emit a heartbeat (stderr, captured in run logs) so a long wait isn't silent. */
function heartbeat(elapsed: number, budgetMs: number, why: string): void {
  if (elapsed >= PROVIDER_LIMITS.retryBackoffMs * 4) {
    process.stderr.write(
      `⏳ model ${why} — retrying (${String(Math.round(elapsed / 1000))}s elapsed, up to ${String(Math.round(budgetMs / 1000))}s)\n`
    );
  }
}

/** Abortable backoff: a caller abort (Ctrl-C) during a multi-second backoff
 *  must reject immediately, not hang until the timer fires. The listener is
 *  removed on the timer path so a long-lived session signal doesn't accrue
 *  one leaked listener per attempt. */
async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signalReason(signal));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
